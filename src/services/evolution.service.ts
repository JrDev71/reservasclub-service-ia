import axios from "axios";
import dotenv from "dotenv";

dotenv.config();

const EVOLUTION_API_URL =
  process.env.EVOLUTION_API_URL || "http://localhost:8080";
const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "";

const evolutionClient = axios.create({
  baseURL: EVOLUTION_API_URL,
  timeout: 15000,
  headers: {
    "Content-Type": "application/json",
    apikey: EVOLUTION_API_KEY,
  },
});

// ⏱️ Função auxiliar para fazer o sistema "respirar"
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const criarInstancia = async (
  instanceName: string,
  numberForPairing?: string,
) => {
  try {
    console.log(
      `[DEBUG Evolution] Verificando estado da instância: ${instanceName}`,
    );

    // Tenta buscar se a instância já existe para evitar erro 403
    try {
      const checkResponse = await evolutionClient.get(
        `/instance/connectionState/${instanceName}`,
      );
      if (checkResponse.data) {
        console.log(
          `[DEBUG Evolution] Instância ${instanceName} já existe. Forçando limpeza para recriar limpa...`,
        );
        await abortarConexaoInstancia(instanceName);
        console.log(
          `[DEBUG Evolution] ⏱️ Aguardando 4s para a VPS purgar o Redis...`,
        );
        await delay(4000);
      }
    } catch (e) {
      // Se der erro ao buscar, significa que ela realmente não existe e pode ser criada
    }

    const webhookUrl =
      process.env.WEBHOOK_URL ||
      "http://host.docker.internal:3001/evolution/webhook";

    const payload: any = {
      instanceName: instanceName,
      qrcode: !numberForPairing,
      integration: "WHATSAPP-BAILEYS",
      webhook: {
        enabled: true,
        url: webhookUrl,
        byEvents: false,
        base64: false,
        events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
      },
    };

    if (numberForPairing) {
      payload.number = numberForPairing.replace(/\D/g, "");
      payload.pairingCode = true;
    }

    const response = await evolutionClient.post("/instance/create", payload);
    return response.data;
  } catch (error: any) {
    if (error.response?.status === 403) {
      console.log(
        `[DEBUG Evolution] Instância travada (403). Deletando forçado: ${instanceName}`,
      );
      try {
        await evolutionClient.delete(`/instance/delete/${instanceName}`);

        console.log(
          `[DEBUG Evolution] ⏱️ Aguardando 4s pós-deleção forçada...`,
        );
        await delay(4000);

        const webhookUrl =
          process.env.WEBHOOK_URL ||
          "http://host.docker.internal:3001/evolution/webhook";

        const payloadRetry: any = {
          instanceName: instanceName,
          qrcode: !numberForPairing,
          integration: "WHATSAPP-BAILEYS",
          webhook: {
            enabled: true,
            url: webhookUrl,
            byEvents: false,
            base64: false,
            events: ["MESSAGES_UPSERT", "CONNECTION_UPDATE", "QRCODE_UPDATED"],
          },
        };
        if (numberForPairing) {
          payloadRetry.number = numberForPairing.replace(/\D/g, "");
          payloadRetry.pairingCode = true;
        }
        const retryResponse = await evolutionClient.post(
          "/instance/create",
          payloadRetry,
        );
        return retryResponse.data;
      } catch (retryError: any) {
        console.error(
          `[Evolution API] Erro crítico ao recriar ${instanceName}:`,
          retryError.response?.data || retryError.message,
        );
        throw retryError;
      }
    }

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

export const conectarInstanciaComCodigo = async (
  instanceName: string,
  number: string,
) => {
  try {
    const cleanNumber = number.replace(/\D/g, "");
    console.log(
      `[DEBUG Evolution] Solicitando Pairing Code via GET para: ${instanceName} / Número: ${cleanNumber}`,
    );

    // 🔥 ROTA CORRIGIDA: Na v2 é apenas GET com o número na query
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
      `[Evolution API] 🛑 Executando obliteração segura para: ${instanceName}`,
    );
    await evolutionClient.delete(`/instance/delete/${instanceName}`);
  } catch (error: any) {
    console.log(
      `[Evolution API] Limpeza processada/ignorada para ${instanceName}.`,
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
