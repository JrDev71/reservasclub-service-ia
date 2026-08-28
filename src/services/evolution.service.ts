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
      qrcode: !numberForPairing,
      integration: "WHATSAPP-BAILEYS",
    };

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
// 🔢 PAIRING CODE (CÓDIGO DE PAREAMENTO)
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
      `[Evolution API] 🛑 Tentando logout limpo para: ${instanceName}`,
    );
    // Tenta primeiro o logout normal da v2 para fechar a sessão do socket sem apagar a instância da base da API
    await evolutionClient.delete(`/instance/logout/${instanceName}`);
  } catch (error: any) {
    // Se a instância já estiver desconectada, ignoramos o erro 400 tranquilamente sem quebrar o fluxo
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
  type: "image" | "video" = "image",
) => {
  try {
    let mediaFormatada = mediaData;
    const isUrl =
      mediaData.startsWith("http://") || mediaData.startsWith("https://");

    if (!isUrl) {
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
        mediatype: type,
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
