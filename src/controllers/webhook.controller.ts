import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { GeminiService } from "../services/gemini.service";
import axios from "axios";

const geminiService = new GeminiService();

// Cache simples para evitar processar a mesma mensagem duas vezes (deduplicação)
const processedMessages = new Set<string>();

export const handleEvolutionWebhook = async (req: Request, res: Response) => {
  const body = req.body;
  const eventName = body.event || (body.events && body.events[0]);

  // 1. Filtragem rápida: Só mensagens novas
  if (String(eventName).toLowerCase() !== "messages.upsert") {
    return res.status(200).send("OK");
  }

  const messageData = body.data;
  const messageId = messageData.key.id;

  // 2. Deduplicação: Se já processamos esse ID nos últimos 2 minutos, ignora
  if (processedMessages.has(messageId)) {
    return res.status(200).send("Duplicate");
  }

  // 3. Segurança: Ignora mensagens próprias
  if (messageData.key.fromMe || messageData.message?.protocolMessage) {
    return res.status(200).send("OK");
  }

  // Registra o ID e programa para remover em 2 minutos para não vazar memória
  processedMessages.add(messageId);
  setTimeout(() => processedMessages.delete(messageId), 120000);

  // Responder 200 OK IMEDIATAMENTE para a Evolution não tentar reenviar por timeout
  res.status(200).send("Processing");

  try {
    const instanceName = body.instance;
    const customerJid = messageData.key.remoteJid;
    const textMessage =
      messageData.message?.conversation ||
      messageData.message?.extendedTextMessage?.text;

    if (!textMessage || !customerJid) return;

    const whatsappInstance = await prisma.whatsappInstance.findUnique({
      where: { instanceName },
      include: { nightclub: { include: { aiAgent: true } } },
    });

    if (!whatsappInstance || !whatsappInstance.nightclub?.aiAgent?.isActive)
      return;

    console.log(`[Webhook] IA processando: ${instanceName} | ID: ${messageId}`);

    const aiResponse = await geminiService.generateResponse(
      whatsappInstance.nightclubId,
      customerJid,
      textMessage,
    );

    if (aiResponse) {
      // Formata a resposta do Gemini para o padrão do WhatsApp
      const formattedResponse = formatForWhatsApp(aiResponse);
      await sendToWhatsApp(instanceName, customerJid, formattedResponse);
    }
  } catch (error: any) {
    console.error("❌ [Webhook Error]:", error.message);
  }
};

/**
 * ✨ Converte formatação Markdown (Gemini) para WhatsApp
 */
function formatForWhatsApp(text: string): string {
  return text
    .replace(/\*\*(.*?)\*\*/g, "*$1*") // **negrito** -> *negrito*
    .replace(/__(.*?)__/g, "_$1_") // __itálico__ -> _itálico_
    .replace(/### (.*?)(\n|$)/g, "*$1*\n") // ### Título -> *Título*
    .replace(/## (.*?)(\n|$)/g, "*$1*\n");
}

async function sendToWhatsApp(instanceName: string, jid: string, text: string) {
  const baseUrl = process.env.EVOLUTION_API_URL?.replace(/\/$/, "");
  const apiKey = process.env.EVOLUTION_API_KEY;

  try {
    await axios.post(
      `${baseUrl}/message/sendText/${instanceName}`,
      {
        number: jid,
        text: text,
        delay: 1000,
        linkPreview: false,
      },
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
