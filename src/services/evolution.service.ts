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
      `[DEBUG Evolution] Tentando criar/reciclar instância: ${instanceName}`,
    );

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
    // ♻️ A MÁGICA DA RECICLAGEM: Se já existe (403), não deleta para não quebrar o banco! Só desloga.
    const isAlreadyInUse =
      error.response?.status === 403 ||
      error.response?.data?.message?.[0]?.includes("already in use");

    if (isAlreadyInUse) {
      console.log(
        `[DEBUG Evolution] ♻️ Instância ${instanceName} já existe no banco. Reciclando sessão...`,
      );
      try {
        // Fazemos apenas o LOGOUT para derrubar a conexão no WhatsApp sem apagar os históricos do banco
        await evolutionClient.delete(`/instance/logout/${instanceName}`);
        await delay(2000); // Dá 2s pro Baileys desligar o motor em paz
      } catch (e) {
        // Se der erro no logout, é porque ela já está desconectada. Segue o jogo!
      }
      return { recycled: true }; // Retorna avisando ao controller que essa instância foi reciclada
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
      `[DEBUG Evolution] Solicitando Pairing Code para: ${instanceName} / Número: ${cleanNumber}`,
    );

    // 🔥 ROTA CORRIGIDA DA V2: Apenas GET passando o número na query
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
    // Trocado de DELETE para LOGOUT para não estourar a Foreign Key do PostgreSQL na v2
    await evolutionClient.delete(`/instance/logout/${instanceName}`);
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
