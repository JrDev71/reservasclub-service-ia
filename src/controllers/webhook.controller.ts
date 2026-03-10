import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { GeminiService } from "../services/gemini.service";
import axios from "axios";

const geminiService = new GeminiService();

export const handleEvolutionWebhook = async (req: Request, res: Response) => {
  console.log("\n=============================================");
  console.log("🔥 [WEBHOOK] BATEU NA PORTA DO RENDER!");
  console.log("=============================================\n");

  try {
    const body = req.body;

    // 1. Filtragem de Eventos
    const eventName = body.event || (body.events && body.events[0]);
    if (String(eventName).toLowerCase() !== "messages.upsert") {
      return res.status(200).send("Evento ignorado");
    }

    const instanceName = body.instance;
    const messageData = body.data;

    // 2. Segurança
    if (messageData.key.fromMe || messageData.message?.protocolMessage) {
      return res.status(200).send("Mensagem própria ignorada");
    }

    // 3. Extração dos dados
    const customerJid = messageData.key.remoteJid;
    const textMessage =
      messageData.message?.conversation ||
      messageData.message?.extendedTextMessage?.text;

    if (!textMessage || !customerJid) {
      return res.status(200).send("Dados incompletos");
    }

    // 4. Busca Instância
    const whatsappInstance = await prisma.whatsappInstance.findUnique({
      where: { instanceName },
      include: {
        nightclub: {
          include: { aiAgent: true },
        },
      },
    });

    if (!whatsappInstance || !whatsappInstance.nightclub?.aiAgent?.isActive) {
      console.log("⚠️ [Webhook] IA Inativa ou Instância não encontrada.");
      return res.status(200).send("IA Inativa");
    }

    // 5. PROCESSAMENTO: Chama o "Cérebro"
    console.log(`[Webhook] IA processando para: ${instanceName}`);

    const aiResponse = await geminiService.generateResponse(
      whatsappInstance.nightclubId,
      customerJid,
      textMessage,
    );

    if (!aiResponse) {
      console.log("⚠️ [Webhook] Gemini não gerou resposta (Cota ou Erro).");
      return res.status(200).send("Sem resposta da IA");
    }

    console.log(
      `[Webhook] Resposta gerada: "${aiResponse.substring(0, 30)}..."`,
    );

    // 6. ENVIO: Formato corrigido para Evolution v2
    await sendToWhatsApp(instanceName, customerJid, aiResponse);

    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error("❌ [Webhook Error]:", error.message);
    return res.status(200).send("Erro processado");
  }
};

/**
 * 📲 Envio corrigido para Evolution API v2.x
 */
async function sendToWhatsApp(instanceName: string, jid: string, text: string) {
  const baseUrl = process.env.EVOLUTION_API_URL?.replace(/\/$/, ""); // Remove barra no final se houver
  const apiKey = process.env.EVOLUTION_API_KEY;

  try {
    console.log(`[WhatsApp] Despachando para Evolution: ${instanceName}`);

    await axios.post(
      `${baseUrl}/message/sendText/${instanceName}`,
      {
        number: jid,
        text: text, // No v2 o texto é direto aqui
        delay: 1200,
        linkPreview: false,
      },
      {
        headers: {
          "Content-Type": "application/json",
          apikey: apiKey,
        },
      },
    );

    console.log(`✅ [WhatsApp] Mensagem entregue ao JID: ${jid}`);
  } catch (error: any) {
    console.error(
      "❌ [WhatsApp Send Error]:",
      error.response?.data || error.message,
    );
  }
}
