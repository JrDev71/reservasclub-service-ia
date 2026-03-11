import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import {
  criarInstancia,
  configurarWebhook,
  conectarInstancia,
} from "../services/evolution.service";

// ============================================================================
// 1. CRIAÇÃO DE NOVA INSTÂNCIA (A primeira vez)
// ============================================================================
export const createNightclubInstance = async (req: Request, res: Response) => {
  try {
    const { nightclubId } = req.body;

    if (!nightclubId) {
      return res
        .status(400)
        .json({ error: "O ID da balada (nightclubId) é obrigatório no body." });
    }

    // 1. Busca a balada para pegar o slug (seu identificador humano)
    const nightclub = await prisma.nightclub.findUnique({
      where: { id: nightclubId as string },
    });

    if (!nightclub) {
      return res.status(404).json({ error: "Balada não encontrada." });
    }

    // 2. Define o nome da instância usando o seu padrão de slug
    const instanceName = `balada_${nightclub.slug}`;

    console.log(
      `[Instance] Iniciando criação na Evolution API: ${instanceName}`,
    );

    // 3. Solicita a criação na Evolution API
    const evolutionResponse = await criarInstancia(instanceName);

    // Extrai o QR Code em Base64 (conforme a estrutura da Evolution)
    const qrCodeBase64 = evolutionResponse?.qrcode?.base64 || "";

    // 4. Configura o Webhook
    // Se o ngrok estiver rodando, use a URL dele no .env (WEBHOOK_URL)
    const webhookUrl =
      process.env.WEBHOOK_URL ||
      "http://host.docker.internal:3001/evolution/webhook";

    await configurarWebhook(instanceName, webhookUrl);

    // 5. Sincroniza com o banco de dados (Upsert para evitar duplicidade)
    const whatsappInstance = await prisma.whatsappInstance.upsert({
      where: { instanceName },
      update: {
        status: "QRCODE",
        qrCode: qrCodeBase64,
        nightclubId: nightclub.id,
      },
      create: {
        instanceName,
        status: "QRCODE",
        qrCode: qrCodeBase64,
        nightclubId: nightclub.id,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Instância pronta. Aguardando leitura do QR Code.",
      instance: {
        id: whatsappInstance.id,
        instanceName: whatsappInstance.instanceName,
        status: whatsappInstance.status,
        qrCode: whatsappInstance.qrCode,
      },
    });
  } catch (error: any) {
    console.error("[Instance Controller Error]", error.message || error);

    // Transforma o erro em string para buscar a mensagem oculta da Evolution
    const errorData = error.response?.data || {};
    const errorStr = JSON.stringify(errorData).toLowerCase();

    // 🛡️ NOVO FILTRO: Agora ele pega o 403 "already in use" da Evolution
    if (
      error.response?.status === 409 ||
      (error.response?.status === 403 && errorStr.includes("already in use")) ||
      error.message?.includes("already exists")
    ) {
      console.log(
        `[Instance] Instância já existe. Avisando backend principal para fazer fallback...`,
      );
      return res.status(409).json({ error: "Instância já existe." });
    }

    return res
      .status(500)
      .json({ error: "Erro ao criar a instância do WhatsApp." });
  }
};

// ============================================================================
// 2. RECONEXÃO / FALLBACK (Quando a instância já existe)
// ============================================================================
export const connectNightclubInstance = async (req: Request, res: Response) => {
  try {
    const { nightclubId } = req.params;

    if (!nightclubId) {
      return res
        .status(400)
        .json({ error: "O ID da balada é obrigatório na URL." });
    }

    const nightclub = await prisma.nightclub.findUnique({
      where: { id: nightclubId as string },
    });

    if (!nightclub) {
      return res.status(404).json({ error: "Balada não encontrada." });
    }

    const instanceName = `balada_${nightclub.slug}`;
    console.log(
      `[Instance] 🔄 Solicitando reconexão/QR Code na Evolution: ${instanceName}`,
    );

    // Solicita a conexão apenas para resgatar o QR Code
    const evolutionResponse = await conectarInstancia(instanceName);

    // Na rota de connect da Evolution, a estrutura do Base64 muda um pouco às vezes
    const qrCodeBase64 =
      evolutionResponse?.base64 || evolutionResponse?.qrcode?.base64 || "";

    // Atualiza o banco de dados com o novo QR Code
    const whatsappInstance = await prisma.whatsappInstance.update({
      where: { instanceName },
      data: {
        status: "QRCODE",
        qrCode: qrCodeBase64,
      },
    });

    return res.status(200).json({
      success: true,
      message: "Novo QR Code gerado com sucesso.",
      instance: {
        id: whatsappInstance.id,
        instanceName: whatsappInstance.instanceName,
        status: whatsappInstance.status,
        qrCode: whatsappInstance.qrCode,
      },
    });
  } catch (error: any) {
    console.error("[Instance Connect Error]", error.message || error);
    return res.status(500).json({ error: "Erro ao reconectar a instância." });
  }
};
