import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import {
  criarInstancia,
  configurarWebhook,
  conectarInstancia,
  abortarConexaoInstancia,
  conectarInstanciaComCodigo, // 🔢 Importação nova aqui!
} from "../services/evolution.service";

// ============================================================================
// 🕰️ FUNÇÃO AUXILIAR: A GUILHOTINA DE 45 SEGUNDOS
// ============================================================================
const iniciarCronometroCancelamento = (instanceName: string) => {
  setTimeout(async () => {
    try {
      const instancia = await prisma.whatsappInstance.findUnique({
        where: { instanceName },
      });

      // Se passou 45s e AINDA está travado no QR Code ou Connecting
      if (
        instancia &&
        (instancia.status === "QRCODE" || instancia.status === "CONNECTING")
      ) {
        console.log(
          `[Timer] ⏰ 45 segundos passaram. Conexão pendente não foi concluída para ${instanceName}. Abortando...`,
        );

        await abortarConexaoInstancia(instanceName);

        await prisma.whatsappInstance.update({
          where: { instanceName },
          data: { status: "DISCONNECTED", qrCode: null },
        });

        console.log(
          `[Timer] 🛑 Instância ${instanceName} resetada para DISCONNECTED.`,
        );
      }
    } catch (error: any) {
      console.error(
        `[Timer Error] Falha ao abortar conexão de ${instanceName}:`,
        error.message,
      );
    }
  }, 45000); // 45 segundos de tolerância
};

// ============================================================================
// 1. CRIAÇÃO DE NOVA INSTÂNCIA (A primeira vez)
// ============================================================================
export const createNightclubInstance = async (req: Request, res: Response) => {
  try {
    const { nightclubId } = req.body;

    if (!nightclubId) return res.status(400).json({ error: "ID obrigatório." });

    const nightclub = await prisma.nightclub.findUnique({
      where: { id: nightclubId as string },
    });

    if (!nightclub)
      return res.status(404).json({ error: "Balada não encontrada." });

    const instanceName = `balada_${nightclub.slug}`;
    console.log(
      `[Instance] Iniciando criação na Evolution API: ${instanceName}`,
    );

    const evolutionResponse = await criarInstancia(instanceName);
    const qrCodeBase64 = evolutionResponse?.qrcode?.base64 || "";

    const webhookUrl =
      process.env.WEBHOOK_URL ||
      "http://host.docker.internal:3001/evolution/webhook";
    await configurarWebhook(instanceName, webhookUrl);

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

    iniciarCronometroCancelamento(instanceName);

    return res.status(200).json({
      success: true,
      instance: whatsappInstance,
    });
  } catch (error: any) {
    console.error("[Instance Controller Error]", error.message || error);

    const errorData = error.response?.data || {};
    const errorStr = JSON.stringify(errorData).toLowerCase();

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

    return res.status(500).json({ error: "Erro ao criar a instância." });
  }
};

// ============================================================================
// 2. RECONEXÃO / FALLBACK (VIA QR CODE TRADICIONAL)
// ============================================================================
export const connectNightclubInstance = async (req: Request, res: Response) => {
  try {
    const { nightclubId } = req.params;

    if (!nightclubId)
      return res.status(400).json({ error: "ID obrigatório na URL." });

    const nightclub = await prisma.nightclub.findUnique({
      where: { id: nightclubId as string },
    });

    if (!nightclub)
      return res.status(404).json({ error: "Balada não encontrada." });

    const instanceName = `balada_${nightclub.slug}`;
    console.log(
      `[Instance] 🔄 Solicitando reconexão na Evolution: ${instanceName}`,
    );

    const webhookUrl =
      process.env.WEBHOOK_URL ||
      "http://host.docker.internal:3001/evolution/webhook";
    await configurarWebhook(instanceName, webhookUrl);

    const evolutionResponse = await conectarInstancia(instanceName);

    const qrCodeBase64 =
      evolutionResponse?.base64 || evolutionResponse?.qrcode?.base64 || null;
    const initialStatus = qrCodeBase64 ? "QRCODE" : "CONNECTING";

    const whatsappInstance = await prisma.whatsappInstance.upsert({
      where: { instanceName },
      update: {
        status: initialStatus,
        qrCode: qrCodeBase64,
      },
      create: {
        instanceName,
        nightclubId: nightclub.id,
        status: initialStatus,
        qrCode: qrCodeBase64,
      },
    });

    iniciarCronometroCancelamento(instanceName);

    return res.status(200).json({
      success: true,
      instance: whatsappInstance,
    });
  } catch (error: any) {
    console.error("[Instance Connect Error]", error.message || error);
    return res.status(500).json({ error: "Erro ao reconectar a instância." });
  }
};

// ============================================================================
// 3. 🔢 RECONEXÃO VIA CÓDIGO DE PAREAMENTO (NOVO MÉTODO)
// ============================================================================
export const connectNightclubWithCode = async (req: Request, res: Response) => {
  try {
    const { nightclubId, number } = req.body;

    if (!nightclubId || !number)
      return res
        .status(400)
        .json({ error: "ID da balada e número do celular são obrigatórios." });

    const nightclub = await prisma.nightclub.findUnique({
      where: { id: nightclubId as string },
    });

    if (!nightclub)
      return res.status(404).json({ error: "Balada não encontrada." });

    const instanceName = `balada_${nightclub.slug}`;
    console.log(
      `[Instance] 🔢 Solicitando Pairing Code na Evolution: ${instanceName} para o número ${number}`,
    );

    const webhookUrl =
      process.env.WEBHOOK_URL ||
      "http://host.docker.internal:3001/evolution/webhook";
    await configurarWebhook(instanceName, webhookUrl);

    // Bate na API da Evolution enviando o número
    const evolutionResponse = await conectarInstanciaComCodigo(
      instanceName,
      number,
    );

    // Extrai o código de pareamento (geralmente vem em evolutionResponse.code)
    const pairingCode =
      evolutionResponse?.code || evolutionResponse?.pairingCode;

    if (!pairingCode) {
      throw new Error(
        "Evolution não retornou o código de pareamento. Verifique se a instância está livre.",
      );
    }

    // Atualiza o banco pra CONNECTING (limpando qualquer QR Code velho)
    await prisma.whatsappInstance.upsert({
      where: { instanceName },
      update: {
        status: "CONNECTING",
        qrCode: null,
      },
      create: {
        instanceName,
        nightclubId: nightclub.id,
        status: "CONNECTING",
        qrCode: null,
      },
    });

    // Inicia a guilhotina. O cliente tem 45s para digitar o código no celular!
    iniciarCronometroCancelamento(instanceName);

    return res.status(200).json({
      success: true,
      code: pairingCode, // Retornamos o código de 8 dígitos pro painel frontend
    });
  } catch (error: any) {
    console.error("[Instance Connect Code Error]", error.message || error);
    return res.status(500).json({
      error:
        "Erro ao gerar código de pareamento. Verifique se o número está correto (com DDI e DDD).",
    });
  }
};
