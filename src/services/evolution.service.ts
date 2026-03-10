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
    throw new Error("Falha ao criar instância no WhatsApp");
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
          events: ["MESSAGES_UPSERT"],
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
 * Envia uma mensagem de texto para um número específico via Evolution API
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
        options: {
          delay: 1200, // Delay humano de 1.2 segundos
          presence: "composing",
        },
        textMessage: {
          text: text,
        },
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
