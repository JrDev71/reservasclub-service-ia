import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const EVOLUTION_API_URL =
  process.env.EVOLUTION_API_URL || "http://localhost:8080";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "";

// Cria um cliente Axios pré-configurado com a URL e a chave de segurança
const evolutionClient = axios.create({
  baseURL: EVOLUTION_API_URL,
  headers: {
    "Content-Type": "application/json",
    apikey: EVOLUTION_API_KEY,
  },
});

/**
 * Cria uma nova instância de WhatsApp para uma balada.
 * Retorna os dados da conexão, incluindo o QR Code em base64.
 */
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

/**
 * Configura a URL de Webhook para onde a Evolution deve enviar as mensagens recebidas.
 */
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
