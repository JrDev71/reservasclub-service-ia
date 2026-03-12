import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { GeminiService } from "../services/gemini.service";
import axios from "axios";

const geminiService = new GeminiService();
const processedMessages = new Set<string>();

export const handleEvolutionWebhook = async (req: Request, res: Response) => {
  const body = req.body;
  const eventName = String(
    body.event || (body.events && body.events[0]),
  ).toLowerCase();
  const instanceName = body.instance;

  // Responder 200 OK IMEDIATAMENTE para a Evolution não dar timeout
  res.status(200).send("Processing");

  try {
    // =======================================================================
    // 🛰️ NOVA ESCUTA: STATUS DE CONEXÃO BLINDADA
    // =======================================================================
    if (eventName === "connection.update") {
      const status = String(
        body.data?.state || body.data?.status,
      ).toLowerCase();

      if (status && status !== "undefined") {
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
            return; // Morre aqui. Não deixa a Main API estragar o status do painel!
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
      }
      return;
    }

    // =======================================================================
    // 📱 ESCUTA: RENOVAÇÃO DO QR CODE
    // =======================================================================
    if (eventName === "qrcode.updated") {
      const base64 = body.data?.qrcode?.base64 || body.data?.base64;

      if (base64) {
        const checkInstance = await prisma.whatsappInstance.findUnique({
          where: { instanceName },
        });

        if (checkInstance && checkInstance.status !== "CONNECTED") {
          console.log(
            `[Sentinela] Renovando QR Code no banco para: ${instanceName}`,
          );
          await prisma.whatsappInstance.update({
            where: { instanceName },
            data: { qrCode: base64, status: "QRCODE" },
          });
        } else {
          console.log(
            `[Sentinela] 👻 QR Code fantasma ignorado. A instância já está CONNECTED.`,
          );
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

    const aiAgent = whatsappInstance.nightclub?.aiAgent;

    if (!aiAgent || aiAgent.isActive === false) {
      console.log(
        `[Webhook] 😴 Robô OFF para ${instanceName}. Mensagem ignorada (Atendimento Humano).`,
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

    if (aiResponse) {
      const formattedResponse = formatForWhatsApp(aiResponse);
      await sendToWhatsApp(instanceName, customerJid, formattedResponse);
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
