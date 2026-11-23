import { Request, Response } from "express";
import { enviarMediaWhatsApp } from "../services/evolution.service";
import { prisma } from "../lib/prisma";
import { GeminiService } from "../services/gemini.service";
import axios from "axios";

const geminiService = new GeminiService();
const processedMessages = new Set<string>();

// =======================================================================
// 🛡️ ESCUDO ANTI-SPAM (Cache em Memória RAM)
// =======================================================================
const statusCache = new Map<string, { state: string; time: number }>();
const lastQrCodeUpdate = new Map<string, number>();
const lastMainApiNotify = new Map<string, { status: string; time: number }>();

const MAIN_API_NOTIFY_COOLDOWN_MS = 15000;

async function notifyMainApiStatus(
  instanceName: string,
  status: string,
  force = false,
): Promise<void> {
  if (!instanceName || !process.env.MAIN_API_URL) return;

  const now = Date.now();
  const prev = lastMainApiNotify.get(instanceName);

  if (
    !force &&
    prev &&
    prev.status === status &&
    now - prev.time < MAIN_API_NOTIFY_COOLDOWN_MS
  ) {
    return;
  }

  lastMainApiNotify.set(instanceName, { status, time: now });

  try {
    await axios.patch(
      `${process.env.MAIN_API_URL}/nightclubs/instance/status`,
      { instanceName, status },
      {
        headers: { "x-internal-key": process.env.MAIN_API_TOKEN },
        timeout: 8000,
      },
    );
  } catch (err: any) {
    const httpStatus = err?.response?.status;
    console.error(
      `❌ Erro ao avisar Main API (${instanceName} -> ${status})${
        httpStatus ? ` [HTTP ${httpStatus}]` : ""
      }:`,
      err?.response?.data || err?.message || err,
    );
  }
}

// 🗺️ DICIONÁRIO DE TAGS -> CHAVES DO BANCO DE DADOS
const tagToDbKeyMap: Record<string, string> = {
  "[ENVIAR_FLYER_SEGUNDA]": "monFlyer",
  "[ENVIAR_FLYER_TERCA]": "tueFlyer",
  "[ENVIAR_FLYER_QUARTA]": "wedFlyer",
  "[ENVIAR_FLYER_QUINTA]": "thuFlyer",
  "[ENVIAR_FLYER_SEXTA]": "friFlyer",
  "[ENVIAR_FLYER_SABADO]": "satFlyer",
  "[ENVIAR_FLYER_DOMINGO]": "sunFlyer",
  "[ENVIAR_VIDEO_ANIVERSARIO]": "birthdayVideo",
  "[ENVIAR_MAPA]": "mapUrl", // O mapa fica na raiz do Nightclub, tratamos ele como exceção
};

export const handleEvolutionWebhook = async (req: Request, res: Response) => {
  const body = req.body || {};
  const eventName = String(
    body.event || (body.events && body.events[0]) || "",
  ).toLowerCase();
  const instanceName = String(body.instance || "").trim();

  // Responder 200 OK IMEDIATAMENTE para a Evolution não dar timeout e parar de spammar
  res.status(200).send("Processing");

  if (!instanceName) return;

  // Apenas avisa que o evento bateu, sem cuspir o payload inteiro
  if (eventName !== "messages.upsert") {
    console.log(`[Webhook] Evento de sistema recebido: ${eventName}`);
  }

  try {
    // =======================================================================
    // 🛰️ NOVA ESCUTA: STATUS DE CONEXÃO BLINDADA
    // =======================================================================
    if (eventName === "connection.update") {
      const status = String(
        body.data?.state || body.data?.status || "",
      ).toLowerCase();

      if (!status || status === "undefined") return;

      const cached = statusCache.get(instanceName);
      if (
        cached &&
        cached.state === status &&
        Date.now() - cached.time < 5000
      ) {
        return;
      }
      statusCache.set(instanceName, { state: status, time: Date.now() });

      console.log(
        `[Sentinela] Instância ${instanceName} mudou para ${status}.`,
      );

      let statusFinal = status;
      const currentState = await prisma.whatsappInstance.findUnique({
        where: { instanceName },
      });

      if (
        status === "refused" ||
        (status === "close" && currentState?.status !== "CONNECTED")
      ) {
        statusFinal = "DISCONNECTED";
        console.log(
          `[Sentinela] Tempo esgotado/Recusado. Limpando QR Code para resetar o botão...`,
        );
        await prisma.whatsappInstance.update({
          where: { instanceName },
          data: { status: "DISCONNECTED", qrCode: null },
        });
      } else if (status === "open" || status === "connected") {
        statusFinal = "CONNECTED";
        console.log(
          `[Sentinela] 🟢 Conexão de sucesso! Atualizando banco para desarmar a guilhotina...`,
        );
        await prisma.whatsappInstance.update({
          where: { instanceName },
          data: { status: "CONNECTED", qrCode: null },
        });
      } else if (status === "connecting" || status === "close") {
        if (currentState?.status === "CONNECTED") {
          console.log(
            `[Sentinela] 🛡️ Blindagem Ativa: Instância flutuou (${status}), mas já está CONNECTED. Ocultando da Main API...`,
          );
          return;
        }
        statusFinal = status === "close" ? "DISCONNECTED" : "CONNECTING";
      }

      await notifyMainApiStatus(instanceName, statusFinal);
      return;
    }

    // =======================================================================
    // 📱 ESCUTA: RENOVAÇÃO DO QR CODE
    // =======================================================================
    if (eventName === "qrcode.updated") {
      const lastUpdate = lastQrCodeUpdate.get(instanceName) || 0;
      if (Date.now() - lastUpdate < 5000) return;

      const base64 = body.data?.qrcode?.base64 || body.data?.base64;

      if (base64) {
        lastQrCodeUpdate.set(instanceName, Date.now());
        const checkInstance = await prisma.whatsappInstance.findUnique({
          where: { instanceName },
        });

        if (checkInstance && checkInstance.status === "CONNECTING") {
          console.log(
            `[Sentinela] 🛡️ Ignorando QR Code de fundo. O usuário está no fluxo de Pairing Code.`,
          );
          return;
        }

        if (checkInstance && checkInstance.status !== "CONNECTED") {
          console.log(
            `[Sentinela] Renovando QR Code no banco para: ${instanceName}`,
          );
          await prisma.whatsappInstance.update({
            where: { instanceName },
            data: { qrCode: base64, status: "QRCODE" },
          });
        }
      }
      return;
    }

    // =======================================================================
    // 💬 ESCUTA DE MENSAGENS E VERIFICAÇÃO ON/OFF DO ROBÔ
    // =======================================================================
    if (eventName !== "messages.upsert") return;

    const messageData = body.data;
    const messageId = messageData?.key?.id;

    if (!messageData || !messageId) return;
    if (processedMessages.has(messageId)) return;
    if (messageData.key.fromMe || messageData.message?.protocolMessage) return;

    processedMessages.add(messageId);
    setTimeout(() => processedMessages.delete(messageId), 120000);

    const customerJid = messageData.key.remoteJid;

    // 🛑 MÁGICA ACONTECENDO AQUI: BLOQUEIO DE GRUPOS E STATUS
    if (
      customerJid &&
      (customerJid.includes("@g.us") || customerJid.includes("broadcast"))
    ) {
      console.log(
        `[IGNORE] 🚫 Mensagem de grupo/status ignorada: ${customerJid}`,
      );
      return; // Para a execução aqui mesmo!
    }

    const textMessage =
      messageData.message?.conversation ||
      messageData.message?.extendedTextMessage?.text;

    if (!textMessage || !customerJid) return;

    // 👇 LOG LIMPO DA MENSAGEM RECEBIDA 👇
    console.log(`\n======================================================`);
    console.log(`📥 [NOVA MENSAGEM] De: ${customerJid}`);
    console.log(`💬 [TEXTO]: "${textMessage}"`);
    console.log(`======================================================\n`);

    const whatsappInstance = await prisma.whatsappInstance.findUnique({
      where: { instanceName },
      include: { nightclub: { include: { aiAgent: true } } },
    });

    if (!whatsappInstance) return;

    // =======================================================================
    // 🩹 AUTO-CURA DO BANCO DE DADOS
    // =======================================================================
    if (whatsappInstance.status !== "CONNECTED") {
      console.log(
        `[Sentinela] 🩹 Auto-cura ativada: Mensagem recebida, forçando status do banco para CONNECTED.`,
      );
      await prisma.whatsappInstance.update({
        where: { instanceName },
        data: { status: "CONNECTED", qrCode: null },
      });
      await notifyMainApiStatus(instanceName, "CONNECTED");
    }

    const aiAgent = whatsappInstance.nightclub?.aiAgent;

    if (!aiAgent || aiAgent.isActive === false) {
      console.log(
        `[Webhook] 😴 Robô OFF para ${instanceName}. Mensagem ignorada.`,
      );
      return;
    }

    console.log(
      `[Webhook] 🤖 Robô ON! Processando: ${instanceName} | ID: ${messageId}`,
    );

    const aiResponse = await geminiService.generateResponse(
      whatsappInstance.nightclubId,
      customerJid,
      textMessage,
    );

    // 👇 LOG LIMPO DA RESPOSTA DA IA 👇
    if (aiResponse) {
      console.log(`\n======================================================`);
      console.log(`🤖 [RESPOSTA DA IA] Para: ${customerJid}`);
      console.log(`🗣️ [TEXTO]: "${aiResponse}"`);
      console.log(`======================================================\n`);
    }

    // =======================================================================
    // 📩 ENVIO DA RESPOSTA E INTERCEPTAÇÃO UNIVERSAL DE MÍDIA
    // =======================================================================
    if (aiResponse) {
      let finalResponse = aiResponse;
      let mediaUrlParaEnviar: string | null = null;
      let mediaCaption = "";
      let isVideo = false; // Controle para saber se é vídeo

      // 1. Procura se a IA usou ALGUMA das tags mapeadas no nosso dicionário
      const tagEncontrada = Object.keys(tagToDbKeyMap).find((tag) =>
        finalResponse.includes(tag),
      );

      if (tagEncontrada) {
        // 2. Remove a tag para o cliente não ler o código fantasma
        finalResponse = finalResponse.replace(tagEncontrada, "").trim();

        const dbKey = tagToDbKeyMap[tagEncontrada];

        // Define se a mídia atual é vídeo (Tag de aniversário)
        isVideo = tagEncontrada === "[ENVIAR_VIDEO_ANIVERSARIO]";

        // 3. Puxa a URL correspondente (O Mapa vem de um lugar, os Flyers de outro)
        if (dbKey === "mapUrl") {
          mediaUrlParaEnviar = whatsappInstance.nightclub?.mapUrl || null;
          mediaCaption = `📍 Mapa de Setores - ${whatsappInstance.nightclub?.name}`;
        } else {
          // Extrai o objeto JSON das mídias
          const mediaLinks =
            (aiAgent.mediaLinks as Record<string, string>) || {};
          mediaUrlParaEnviar = mediaLinks[dbKey] || null;

          // Legenda personalizada se for Aniversário ou Flyer
          mediaCaption =
            tagEncontrada === "[ENVIAR_VIDEO_ANIVERSARIO]"
              ? `🎂 Promoção de Aniversário - ${whatsappInstance.nightclub?.name}`
              : `🎉 Programação - ${whatsappInstance.nightclub?.name}`;
        }
      }

      // 4. Envia o texto da resposta normalmente (agora sem a tag)
      if (finalResponse.length > 0) {
        const formattedResponse = formatForWhatsApp(finalResponse);
        await sendToWhatsApp(instanceName, customerJid, formattedResponse);
      }

      // 5. Se a tag foi ativada, dispara a mídia logo em seguida
      if (tagEncontrada) {
        if (mediaUrlParaEnviar) {
          console.log(
            `[Webhook] 📸 Gatilho '${tagEncontrada}' acionado! Enviando mídia...`,
          );

          setTimeout(async () => {
            await enviarMediaWhatsApp(
              instanceName,
              customerJid,
              mediaUrlParaEnviar!,
              mediaCaption,
              isVideo ? "video" : "image", // Agora passamos o tipo correto aqui
            );
          }, 1500);
        } else {
          console.log(
            `[Webhook] ⚠️ Gatilho '${tagEncontrada}' acionado, mas a URL estava vazia no banco.`,
          );

          // Fallback elegante se o banco retornar nulo pra mídia
          const msgSemMidia =
            tagEncontrada === "[ENVIAR_MAPA]"
              ? "Poxa, peço desculpas, mas no momento estou sem a foto do nosso mapa por aqui! 😕 Mas posso te explicar como funcionam os setores, qual você prefere?"
              : "Poxa, peço desculpas, mas a arte desse evento ainda não está disponível no sistema! 😕 Mas qualquer dúvida sobre a programação, é só falar.";

          setTimeout(async () => {
            await sendToWhatsApp(instanceName, customerJid, msgSemMidia);
          }, 1500);
        }
      }
    }
  } catch (error: any) {
    console.error("❌ [Webhook Error]:", error.message);
  }
};

function formatForWhatsApp(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "*$1*")
    .replace(/__(.*?)__/g, "_$1_")
    .replace(/### (.*?)(\n|$)/g, "*$1*\n")
    .replace(/## (.*?)(\n|$)/g, "*$1*\n");
}

async function sendToWhatsApp(instanceName: string, jid: string, text: string) {
  const baseUrl = process.env.EVOLUTION_API_URL?.replace(/\/$/, "");
  const apiKey = process.env.EVOLUTION_API_KEY;

  try {
    await axios.post(
      `${baseUrl}/message/sendText/${instanceName}`,
      { number: jid, text: text, delay: 1000, linkPreview: false },
      { headers: { apikey: apiKey } },
    );
    console.log(`✅ [WhatsApp] Resposta enviada para ${jid}`);
  } catch (error: any) {
    console.error(
      "❌ [WhatsApp Error]:",
      error.response?.data || error.message,
    );
  }
}
