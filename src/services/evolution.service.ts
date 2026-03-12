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
    throw error;
  }
};

export const conectarInstancia = async (instanceName: string) => {
  try {
    console.log(
      `[DEBUG Evolution] Solicitando reconexão/QR Code para: ${instanceName}`,
    );

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

// ============================================================================
// 🔢 NOVA FUNÇÃO: PAIRING CODE (CÓDIGO DE PAREAMENTO)
// ============================================================================
export const conectarInstanciaComCodigo = async (
  instanceName: string,
  number: string,
) => {
  try {
    // Limpa qualquer máscara do número antes de enviar para a Evolution
    const cleanNumber = number.replace(/\D/g, "");

    console.log(
      `[DEBUG Evolution] Solicitando Código de Pareamento para: ${instanceName} / Número: ${cleanNumber}`,
    );

    const response = await evolutionClient.get(
      `/instance/connect/${instanceName}?number=${cleanNumber}`,
    );

    return response.data;
  } catch (error: any) {
    console.error(
      `[Evolution API] Erro ao gerar código de pareamento para ${instanceName}:`,
      error.response?.data || error.message,
    );
    throw new Error("Falha ao gerar código de pareamento");
  }
};

export const abortarConexaoInstancia = async (instanceName: string) => {
  try {
    console.log(
      `[Evolution API] 🛑 Cortando conexão pendente (Logout) para: ${instanceName}`,
    );
    await evolutionClient.delete(`/instance/logout/${instanceName}`);
  } catch (error: any) {
    console.log(
      `[Evolution API] Logout processado/ignorado para ${instanceName}.`,
    );
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

export const enviarMediaWhatsApp = async (
  instanceName: string,
  number: string,
  base64Data: string,
  caption: string = "",
) => {
  try {
    const mediaFormatada = base64Data.includes("base64,")
      ? base64Data
      : `data:image/png;base64,${base64Data}`;

    const response = await evolutionClient.post(
      `/message/sendMedia/${instanceName}`,
      {
        number: number,
        mediatype: "image",
        mimetype: "image/png",
        caption: caption,
        media: mediaFormatada,
        delay: 1500,
      },
    );
    return response.data;
  } catch (error: any) {
    console.error(
      `[Evolution API] Erro ao enviar mídia para ${number}:`,
      error.response?.data || error.message,
    );
  }
};
