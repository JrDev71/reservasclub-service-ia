import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import {
  criarInstancia,
  configurarWebhook,
} from "../services/evolution.service";

export const createNightclubInstance = async (req: Request, res: Response) => {
  try {
    const { nightclubId } = req.body;

    if (!nightclubId) {
      return res
        .status(400)
        .json({ error: "O ID da balada (nightclubId) é obrigatório no body." });
    }

    // Verifica se a balada realmente existe no seu banco de dados atual
    const nightclub = await prisma.nightclub.findUnique({
      where: { id: nightclubId },
    });

    if (!nightclub) {
      return res.status(404).json({ error: "Balada não encontrada." });
    }

    // Cria um nome único para a instância baseado no slug para não dar conflito na Evolution
    const instanceName = `balada_${nightclub.slug}`;

    console.log(
      `[Instance] Solicitando criação na Evolution API para: ${instanceName}`,
    );

    // 1. Chama a Evolution API para criar a instância e gerar o QR Code
    const evolutionResponse = await criarInstancia(instanceName);

    // A Evolution devolve o base64 dentro do objeto qrcode quando passamos qrcode: true
    const qrCodeBase64 = evolutionResponse?.qrcode?.base64 || "";

    // 2. Configura o Webhook na Evolution API
    // Dica de ouro: Como a Evolution está rodando dentro do Docker e nosso Node.js está rodando
    // direto na sua máquina (host), o Docker usa 'host.docker.internal' para enxergar o seu localhost.
    const webhookUrl =
      process.env.WEBHOOK_URL ||
      "http://host.docker.internal:3001/webhooks/evolution";
    await configurarWebhook(instanceName, webhookUrl);

    // 3. Salva (ou atualiza se já existir) a instância no banco de dados
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

    // Retorna os dados limpos para o seu frontend renderizar a imagem
    return res.status(200).json({
      success: true,
      message: "Instância criada com sucesso. Leia o QR Code para conectar.",
      instance: {
        id: whatsappInstance.id,
        instanceName: whatsappInstance.instanceName,
        status: whatsappInstance.status,
        qrCode: whatsappInstance.qrCode,
      },
    });
  } catch (error: any) {
    console.error("[Instance Controller Error]", error.message || error);
    return res
      .status(500)
      .json({ error: "Erro ao criar a instância do WhatsApp." });
  }
};
