import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const EVOLUTION_API_URL =
  process.env.EVOLUTION_API_URL || "http://localhost:8080";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "";

const evolutionClient = axios.create({
  baseURL: EVOLUTION_API_URL,
  headers: {
    "Content-Type": "application/json",
    apikey: EVOLUTION_API_KEY,
  },
});

export const criarInstancia = async (instanceName: string) => {
  try {
    console.log(
      `[DEBUG Evolution] URL recebida do .env: "${EVOLUTION_API_URL}"`,
    );
    console.log(
      `[DEBUG Evolution] KEY recebida do .env: "${EVOLUTION_API_KEY}"`,
    );
    console.log(`[DEBUG Evolution] Tentando criar instância: ${instanceName}`);

    const response = await evolutionClient.post("/instance/create", {
      instanceName: instanceName,
      qrcode: true,
      integration: "WHATSAPP-BAILEYS",
    });
    return response.data;
  } catch (error: any) {
    console.error(
      `[Evolution API] Erro ao criar instância ${instanceName}:`,
      error.response?.data || error.message,
    );
    throw error; // 🛡️ Repassamos o erro original para o controller saber se é 409
  }
};

// ============================================================================
// 🔄 NOVA FUNÇÃO: RECONEXÃO / FALLBACK
// ============================================================================
export const conectarInstancia = async (instanceName: string) => {
  try {
    console.log(
      `[DEBUG Evolution] Solicitando reconexão/QR Code para: ${instanceName}`,
    );

    // A rota GET /instance/connect devolve o status e o QR Code em Base64
    const response = await evolutionClient.get(
      `/instance/connect/${instanceName}`,
    );

    return response.data;
  } catch (error: any) {
    console.error(
      `[Evolution API] Erro ao reconectar instância ${instanceName}:`,
      error.response?.data || error.message,
    );
    throw new Error("Falha ao reconectar instância no WhatsApp");
  }
};

export const configurarWebhook = async (
  instanceName: string,
  webhookUrl: string,
) => {
  try {
    const response = await evolutionClient.post(
      `/webhook/set/${instanceName}`,
      {
        webhook: {
          enabled: true,
          url: webhookUrl,
          byEvents: false,
          base64: false,
          events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
        },
      },
    );
    return response.data;
  } catch (error: any) {
    console.error(
      `[Evolution API] Erro ao configurar webhook da instância ${instanceName}:`,
      error.response?.data || error.message,
    );
    throw new Error("Falha ao configurar webhook");
  }
};

/**
 * Envia uma mensagem de texto (Atualizado para o padrão Evolution v2)
 */
export const enviarMensagemWhatsApp = async (
  instanceName: string,
  number: string,
  text: string,
) => {
  try {
    const response = await evolutionClient.post(
      `/message/sendText/${instanceName}`,
      {
        number: number,
        text: text,
        delay: 1200,
        linkPreview: false,
      },
    );
    return response.data;
  } catch (error: any) {
    console.error(
      `[Evolution API] Erro ao enviar mensagem para ${number}:`,
      error.response?.data || error.message,
    );
  }
};
