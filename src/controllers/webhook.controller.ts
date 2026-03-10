import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { GeminiService } from "../services/gemini.service";
import axios from "axios";

// Instanciamos o serviço que configuramos no passo anterior
const geminiService = new GeminiService();

export const handleEvolutionWebhook = async (req: Request, res: Response) => {
  // 🔥 ESSE LOG VAI GRITAR ASSIM QUE A EVOLUTION BATER NA PORTA
  console.log("\n=============================================");
  console.log("🔥 [WEBHOOK] BATEU NA PORTA DO RENDER!");
  console.log("📦 DADOS DO CORPO (BODY):", JSON.stringify(req.body, null, 2));
  console.log("=============================================\n");

  try {
    const body = req.body;

    // 1. Filtragem de Eventos: Deixamos case-insensitive para não morrer silenciosamente
    const eventName = body.event || (body.events && body.events[0]);
    if (String(eventName).toLowerCase() !== "messages.upsert") {
      console.log(`⚠️ [Webhook] Evento ignorado. Recebido: ${eventName}`);
      return res.status(200).send("Evento ignorado");
    }

    const instanceName = body.instance;
    const messageData = body.data;

    // 2. Segurança: Ignora mensagens do próprio bot ou de sistema
    if (messageData.key.fromMe || messageData.message?.protocolMessage) {
      console.log("⚠️ [Webhook] Mensagem própria do bot ignorada.");
      return res.status(200).send("Mensagem própria ignorada");
    }

    // 3. Extração do Texto e do Remetente
    const customerJid = messageData.key.remoteJid; // ID do cliente no WhatsApp
    const textMessage =
      messageData.message?.conversation ||
      messageData.message?.extendedTextMessage?.text;

    if (!textMessage || !customerJid) {
      console.log("⚠️ [Webhook] Dados incompletos. Faltou texto ou JID.");
      return res.status(200).send("Dados incompletos");
    }

    // 4. Busca a Instância e o Agente de IA
    const whatsappInstance = await prisma.whatsappInstance.findUnique({
      where: { instanceName },
      include: {
        nightclub: {
          include: { aiAgent: true },
        },
      },
    });

    if (!whatsappInstance || !whatsappInstance.nightclub?.aiAgent?.isActive) {
      console.log(
        "⚠️ [Webhook] IA Inativa ou Instância não encontrada no banco.",
      );
      return res.status(200).send("IA Inativa ou Instância não encontrada");
    }

    const nightclubId = whatsappInstance.nightclubId;

    // 5. PROCESSAMENTO: Chama o "Cérebro" (Gemini)
    console.log(
      `[Webhook] IA processando mensagem de ${customerJid} para: ${instanceName}`,
    );
    console.log(`[Webhook] Texto recebido: "${textMessage}"`);

    // O GeminiService agora busca os preços e o treinamento dinamicamente
    const aiResponse = await geminiService.generateResponse(
      nightclubId,
      customerJid,
      textMessage,
    );

    if (!aiResponse) {
      console.log(
        "⚠️ [Webhook] Gemini retornou vazio. IA optou por não responder.",
      );
      return res.status(200).send("IA optou por não responder");
    }

    // 6. ENVIO: Devolve a resposta para a Evolution API (WhatsApp)
    await sendToWhatsApp(instanceName, customerJid, aiResponse);

    return res.status(200).json({ success: true });
  } catch (error: any) {
    console.error("❌ [Webhook Error]:", error.message);
    // Em produção, não retornamos erro 500 para o Webhook para evitar loops de retry do servidor de origem
    return res.status(200).send("Erro processado internamente");
  }
};

/**
 * 📲 Função auxiliar para enviar a mensagem via Evolution API
 */
async function sendToWhatsApp(instanceName: string, jid: string, text: string) {
  const baseUrl = process.env.EVOLUTION_API_URL;
  const apiKey = process.env.EVOLUTION_API_KEY;

  try {
    console.log(`[WhatsApp] Tentando enviar resposta para ${jid}...`);
    await axios.post(
      `${baseUrl}/message/sendText/${instanceName}`,
      {
        number: jid,
        options: {
          delay: 1200, // Simula tempo de leitura/digitação
          presence: "composing", // Mostra "Digitando..." no WhatsApp
          linkPreview: false,
        },
        textMessage: {
          text: text,
        },
      },
      {
        headers: { apikey: apiKey },
      },
    );
    console.log(`✅ [WhatsApp] Resposta enviada com sucesso para ${jid}`);
  } catch (error: any) {
    console.error(
      "❌ [WhatsApp Send Error]:",
      error.response?.data || error.message,
    );
  }
}
