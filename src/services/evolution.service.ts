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

export const criarInstancia = async (
  instanceName: string,
  numberForPairing?: string,
) => {
  try {
    console.log(`[DEBUG Evolution] URL recebida: "${EVOLUTION_API_URL}"`);
    console.log(`[DEBUG Evolution] Tentando criar instância: ${instanceName}`);

    const payload: any = {
      instanceName: instanceName,
      qrcode: !numberForPairing, // Se enviou número, arranca o QR Code na raiz!
      integration: "WHATSAPP-BAILEYS",
    };

    // O pulo do gato: já mandar o número e a flag na criação
    if (numberForPairing) {
      payload.number = numberForPairing.replace(/\D/g, "");
      payload.pairingCode = true;
    }

    const response = await evolutionClient.post("/instance/create", payload);
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
    const cleanNumber = number.replace(/\D/g, "");
    console.log(
      `[DEBUG Evolution] Solicitando Pairing Code para: ${instanceName} / Número: ${cleanNumber}`,
    );

    // Tentativa 1: Via Rota Específica GET com query e header
    try {
      const responseNovo = await evolutionClient.get(
        `/instance/connect/${instanceName}?number=${cleanNumber}`,
        {
          headers: {
            "Content-Type": "application/json",
            reject_qrcode: "true",
          },
        },
      );
      if (responseNovo.data?.code || responseNovo.data?.pairingCode) {
        return responseNovo.data;
      }
    } catch (e) {
      console.log(
        "[DEBUG Evolution] Rota GET /connect não retornou o código, tentando POST de configuração...",
      );
    }

    // Tentativa 2: Via POST Payload de Configuração (Algumas versões exigem assim)
    const response = await evolutionClient.post(
      `/instance/connect/${instanceName}`,
      {
        number: cleanNumber,
        pairingCode: true,
      },
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
      `[Evolution API] 🛑 Cortando conexão pendente e deletando zumbi: ${instanceName}`,
    );
    // 👇 O pulo do gato para a v2: usar /delete em vez de /logout
    await evolutionClient.delete(`/instance/delete/${instanceName}`);
  } catch (error: any) {
    console.log(
      `[Evolution API] Deleção processada/ignorada para ${instanceName}.`,
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
      { number: number, text: text, delay: 1200, linkPreview: false },
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
  mediaData: string,
  caption: string = "",
  type: "image" | "video" = "image", // 👈 Adicionamos o tipo aqui, padrão image
) => {
  try {
    let mediaFormatada = mediaData;
    const isUrl =
      mediaData.startsWith("http://") || mediaData.startsWith("https://");

    if (!isUrl) {
      // Se for base64, ajustamos o prefixo conforme o tipo
      const prefix =
        type === "video" ? "data:video/mp4;base64," : "data:image/png;base64,";
      mediaFormatada = mediaData.includes("base64,")
        ? mediaData
        : `${prefix}${mediaData}`;
    }

    const response = await evolutionClient.post(
      `/message/sendMedia/${instanceName}`,
      {
        number: number,
        mediatype: type, // 👈 Agora ele usa o tipo dinâmico!
        ...(isUrl
          ? {}
          : { mimetype: type === "video" ? "video/mp4" : "image/png" }),
        caption: caption,
        media: mediaFormatada,
        delay: 1500,
      },
    );
    return response.data;
  } catch (error: any) {
    console.error(
      `[Evolution API] Erro ao enviar mídia (${type}) para ${number}:`,
      error.response?.data || error.message,
    );
  }
};
