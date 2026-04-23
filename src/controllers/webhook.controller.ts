import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { GeminiService } from "../services/gemini.service";
import axios from "axios";
// 👈 Adicionada a importação para o envio de imagens
import { enviarMediaWhatsApp } from "../services/evolution.service";

const geminiService = new GeminiService();
const processedMessages = new Set<string>();

// =======================================================================
// 🛡️ ESCUDO ANTI-SPAM (Cache em Memória RAM)
// =======================================================================
const statusCache = new Map<string, { state: string; time: number }>();
const lastQrCodeUpdate = new Map<string, number>();

export const handleEvolutionWebhook = async (req: Request, res: Response) => {
  const body = req.body;
  const eventName = String(
    body.event || (body.events && body.events[0]),
  ).toLowerCase();
  const instanceName = body.instance;

  // Responder 200 OK IMEDIATAMENTE para a Evolution não dar timeout e parar de spammar
  res.status(200).send("Processing");

  try {
    // =======================================================================
    // 🛰️ NOVA ESCUTA: STATUS DE CONEXÃO BLINDADA
    // =======================================================================
    if (eventName === "connection.update") {
      const status = String(
        body.data?.state || body.data?.status,
      ).toLowerCase();

      if (!status || status === "undefined") return;

      // 🛡️ BLOQUEIO DE SPAM: Se a Evolution mandar o mesmo status em menos de 5 segundos, morre aqui!
      const cached = statusCache.get(instanceName);
      if (
        cached &&
        cached.state === status &&
        Date.now() - cached.time < 5000
      ) {
        return; // Ignora o spam. Poupamos 1 query no banco e 1 requisição HTTP!
      }
      // Salva o novo status na memória
      statusCache.set(instanceName, { state: status, time: Date.now() });

      console.log(
        `[Sentinela] Instância ${instanceName} mudou para ${status}.`,
      );

      let statusFinal = status;

      // Puxa a verdade absoluta do banco antes de tomar decisão
      const currentState = await prisma.whatsappInstance.findUnique({
        where: { instanceName },
      });

      // 🛑 TRAVA: Se falhou/expirou (e não estava conectado)
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
      }
      // ✅ SALVAÇÃO: Se conectou, atualiza na hora e desarma a guilhotina!
      else if (status === "open" || status === "connected") {
        statusFinal = "CONNECTED";
        console.log(
          `[Sentinela] 🟢 Conexão de sucesso! Atualizando banco para desarmar a guilhotina...`,
        );

        await prisma.whatsappInstance.update({
          where: { instanceName },
          data: { status: "CONNECTED", qrCode: null },
        });
      }
      // 🛡️ BLINDAGEM CONTRA RESTART DO RENDER
      else if (status === "connecting" || status === "close") {
        if (currentState?.status === "CONNECTED") {
          console.log(
            `[Sentinela] 🛡️ Blindagem Ativa: Instância flutuou (${status}), mas já está CONNECTED. Ocultando da Main API...`,
          );
          return;
        }
        statusFinal = status === "close" ? "DISCONNECTED" : "CONNECTING";
      }

      // Avisando Main API sobre a mudança de status
      await axios
        .patch(
          `${process.env.MAIN_API_URL}/nightclubs/instance/status`,
          { instanceName, status: statusFinal },
          { headers: { "x-internal-key": process.env.MAIN_API_TOKEN } },
        )
        .catch((err) =>
          console.error("❌ Erro ao avisar Main API:", err.message),
        );

      return;
    }

    // =======================================================================
    // 📱 ESCUTA: RENOVAÇÃO DO QR CODE
    // =======================================================================
    if (eventName === "qrcode.updated") {
      // 🛡️ BLOQUEIO DE SPAM: Só permite processar 1 QR Code a cada 5 segundos
      const lastUpdate = lastQrCodeUpdate.get(instanceName) || 0;
      if (Date.now() - lastUpdate < 5000) return;

      const base64 = body.data?.qrcode?.base64 || body.data?.base64;

      if (base64) {
        // Renova o tempo na memória
        lastQrCodeUpdate.set(instanceName, Date.now());

        const checkInstance = await prisma.whatsappInstance.findUnique({
          where: { instanceName },
        });

        // 🛑 TRAVA DE OURO: Ignora o QR Code se o cara estiver gerando o Pairing Code!
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
    const textMessage =
      messageData.message?.conversation ||
      messageData.message?.extendedTextMessage?.text;

    if (!textMessage || !customerJid) return;

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

      await axios
        .patch(
          `${process.env.MAIN_API_URL}/nightclubs/instance/status`,
          { instanceName, status: "CONNECTED" },
          { headers: { "x-internal-key": process.env.MAIN_API_TOKEN } },
        )
        .catch(() => {});
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

    // =======================================================================
    // 📩 ENVIO DA RESPOSTA E INTERCEPTAÇÃO DE MÍDIA
    // =======================================================================
    if (aiResponse) {
      // 1. Verifica se a IA acionou a tag para enviar o mapa
      const requiresMap = aiResponse.includes("[ENVIAR_MAPA]");

      // 2. Remove a tag para não aparecer no WhatsApp do cliente
      let finalResponse = aiResponse;
      if (requiresMap) {
        finalResponse = aiResponse.replace("[ENVIAR_MAPA]", "").trim();
      }

      // 3. Envia o texto da resposta normalmente
      if (finalResponse.length > 0) {
        const formattedResponse = formatForWhatsApp(finalResponse);
        await sendToWhatsApp(instanceName, customerJid, formattedResponse);
      }

      // 4. Se a tag foi ativada, puxa a foto e dispara logo em seguida
      if (requiresMap) {
        const fotoMapaUrl = whatsappInstance.nightclub?.mapUrl;

        if (fotoMapaUrl) {
          console.log(
            `[Webhook] 🗺️ IA acionou gatilho de Mapa para ${customerJid}! Enviando imagem...`,
          );

          // Aguarda um pouquinho para a foto chegar logo após o texto
          setTimeout(async () => {
            await enviarMediaWhatsApp(
              instanceName,
              customerJid,
              fotoMapaUrl, // 👈 Usando o seu mapUrl certinho
              `📍 Mapa de Setores - ${whatsappInstance.nightclub?.name}`, // 👈 Nome dinâmico da balada!
            );
          }, 1500);
        } else {
          console.log(
            `[Webhook] ⚠️ Gatilho de mapa acionado, mas 'mapUrl' está vazio no banco de dados.`,
          );

          // Avisa o cliente educadamente que o sistema não tem a foto ainda
          const msgSemMapa =
            "Poxa, peço desculpas, mas no momento estou sem a foto do nosso mapa por aqui! 😕 Mas posso te explicar como funcionam os setores, qual você prefere?";
          setTimeout(async () => {
            await sendToWhatsApp(instanceName, customerJid, msgSemMapa);
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
