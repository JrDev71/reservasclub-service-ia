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

        // ✅ SALVAÇÃO: Se conectou, atualiza na hora e desarma a guilhotina!
        if (status === "open" || status === "connected") {
          statusFinal = "CONNECTED";
          console.log(
            `[Sentinela] 🟢 Conexão de sucesso! Atualizando banco para desarmar a guilhotina...`,
          );

          await prisma.whatsappInstance.update({
            where: { instanceName },
            data: { status: "CONNECTED", qrCode: null },
          });
        }
        // 🔴 RECUSA: O usuário cancelou a conexão no celular
        else if (status === "refused") {
          statusFinal = "DISCONNECTED";
          console.log(
            `[Sentinela] 🔴 Conexão recusada pelo aparelho. Limpando...`,
          );

          await prisma.whatsappInstance.update({
            where: { instanceName },
            data: { status: "DISCONNECTED", qrCode: null },
          });
        }
        // 🟡 CLOSE / CONNECTING: O WhatsApp faz dezenas de mini-quedas para sincronizar (Baileys refresh).
        // Não apagamos nada do banco! O verdadeiro timeout de QR Code é controlado apenas pela Guilhotina de 45s.
        else if (status === "close" || status === "connecting") {
          statusFinal = status === "close" ? "DISCONNECTED" : "CONNECTING"; // Apenas para repassar à Main API
          console.log(
            `[Sentinela] 🟡 Instância em flutuação (${status}). Ignorando ações no banco...`,
          );
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
    // 📱 ESCUTA: RENOVAÇÃO DO QR CODE (A cada 10~15s)
    // =======================================================================
    if (eventName === "qrcode.updated") {
      const base64 = body.data?.qrcode?.base64 || body.data?.base64;

      if (base64) {
        // Só salva o QR Code se o cara não estiver conectado
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
