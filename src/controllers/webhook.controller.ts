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
    // 🛰️ NOVA ESCUTA: STATUS DE CONEXÃO (Avisa a Main API)
    // =======================================================================
    if (eventName === "connection.update") {
      const status = body.data?.state || body.data?.status;

      if (status) {
        console.log(
          `[Sentinela] Instância ${instanceName} mudou para ${status}. Avisando Main API...`,
        );

        await axios
          .patch(
            `${process.env.MAIN_API_URL}/nightclubs/instance/status`,
            { instanceName, status },
            { headers: { "x-internal-key": process.env.MAIN_API_TOKEN } },
          )
          .catch((err) =>
            console.error("❌ Erro ao avisar Main API:", err.message),
          );
      }
      return;
    }

    // Se for QR Code, apenas registramos no log por enquanto
    if (eventName === "qrcode.updated") {
      console.log(`[Sentinela] Novo QR Code para a instância: ${instanceName}`);
      return;
    }

    // =======================================================================
    // 💬 ESCUTA DE MENSAGENS E VERIFICAÇÃO ON/OFF DO ROBÔ
    // =======================================================================
    if (eventName !== "messages.upsert") return;

    const messageData = body.data;
    const messageId = messageData?.key?.id;

    if (!messageData || !messageId) return;

    // Deduplicação (evita responder a mesma mensagem duas vezes)
    if (processedMessages.has(messageId)) return;
    if (messageData.key.fromMe || messageData.message?.protocolMessage) return;

    processedMessages.add(messageId);
    setTimeout(() => processedMessages.delete(messageId), 120000);

    const customerJid = messageData.key.remoteJid;
    const textMessage =
      messageData.message?.conversation ||
      messageData.message?.extendedTextMessage?.text;

    if (!textMessage || !customerJid) return;

    // 1. Busca a instância e verifica as configurações da IA no banco
    const whatsappInstance = await prisma.whatsappInstance.findUnique({
      where: { instanceName },
      include: { nightclub: { include: { aiAgent: true } } },
    });

    if (!whatsappInstance) return;

    const aiAgent = whatsappInstance.nightclub?.aiAgent;

    // 🛑 A TRAVA: Se o Agente não existir ou estiver OFF, encerra aqui silenciosamente (humano atende)
    if (!aiAgent || aiAgent.isActive === false) {
      console.log(
        `[Webhook] 😴 Robô OFF para ${instanceName}. Mensagem ignorada (Atendimento Humano).`,
      );
      return;
    }

    // 🤖 SE PASSOU DA TRAVA, O ROBÔ ESTÁ ON!
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
