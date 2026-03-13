import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import axios from "axios";
import {
  criarInstancia,
  configurarWebhook,
  conectarInstancia,
  abortarConexaoInstancia,
  conectarInstanciaComCodigo,
} from "../services/evolution.service";

// ============================================================================
// 🪓 FUNÇÃO AUXILIAR: A VOADORA DE LOGOUT (RAIO-X DE ERRO ATIVADO)
// ============================================================================
const forcarDesconexao = async (instanceName: string) => {
  const EVOLUTION_API_URL =
    process.env.EVOLUTION_API_URL || "http://localhost:8080";
  const EVOLUTION_API_KEY = process.env.EVOLUTION_API_KEY || "";

  try {
    console.log(
      `\n[Instance] ☢️ 1. Tentando Deletar a instância fantasma na Evolution: ${instanceName}`,
    );
    await axios.delete(`${EVOLUTION_API_URL}/instance/delete/${instanceName}`, {
      headers: { apikey: EVOLUTION_API_KEY },
      timeout: 5000,
    });
    console.log(
      `[Instance] ✅ Instância deletada com sucesso. Aguardando 2s...`,
    );
    await new Promise((resolve) => setTimeout(resolve, 2000));
  } catch (error: any) {
    console.log(
      `\n[Instance] ⚠️ O Delete falhou. Raio-X do Erro:`,
      JSON.stringify(error.response?.data || error.message, null, 2),
    );

    try {
      console.log(`\n[Instance] 🪓 2. Tentando Logout normal como Plano B...`);
      await axios.delete(
        `${EVOLUTION_API_URL}/instance/logout/${instanceName}`,
        {
          headers: { apikey: EVOLUTION_API_KEY },
          timeout: 5000,
        },
      );
      console.log(`[Instance] ✅ Logout normal funcionou.`);
    } catch (e2: any) {
      console.log(
        `[Instance] ⚠️ Logout normal também falhou. Motivo: ${e2.response?.data?.error || e2.message}`,
      );
    }
  }

  await new Promise((resolve) => setTimeout(resolve, 2000));
};

// ============================================================================
// 🕰️ FUNÇÃO AUXILIAR: A GUILHOTINA DE 45 SEGUNDOS
// ============================================================================
const iniciarCronometroCancelamento = (instanceName: string) => {
  setTimeout(async () => {
    try {
      const instancia = await prisma.whatsappInstance.findUnique({
        where: { instanceName },
      });

      if (
        instancia &&
        (instancia.status === "QRCODE" || instancia.status === "CONNECTING")
      ) {
        console.log(
          `[Timer] ⏰ 45s passaram. Conexão não concluída para ${instanceName}.`,
        );

        await abortarConexaoInstancia(instanceName);

        await prisma.whatsappInstance.update({
          where: { instanceName },
          data: { status: "DISCONNECTED", qrCode: null },
        });

        console.log(
          `[Timer] 🛑 Instância ${instanceName} resetada para DISCONNECTED no banco.`,
        );
      }
    } catch (error: any) {
      console.error(
        `[Timer Error] Falha ao abortar conexão de ${instanceName}:`,
        error.message,
      );
    }
  }, 45000);
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

    return res.status(200).json({ success: true, instance: whatsappInstance });
  } catch (error: any) {
    console.error("[Instance Controller Error]", error.message || error);
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
      `\n[Instance] 🔄 Iniciando Fluxo de QR Code para: ${instanceName}`,
    );

    await forcarDesconexao(instanceName);

    try {
      console.log(`[Instance] 🏗️ Reconstruindo a instância na Evolution...`);
      await criarInstancia(instanceName);
    } catch (e: any) {
      console.log(
        `[Instance] ℹ️ Aviso (ignorável): Instância já existia. Seguindo...`,
      );
    }

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
      update: { status: initialStatus, qrCode: qrCodeBase64 },
      create: {
        instanceName,
        nightclubId: nightclub.id,
        status: initialStatus,
        qrCode: qrCodeBase64,
      },
    });

    iniciarCronometroCancelamento(instanceName);

    return res.status(200).json({ success: true, instance: whatsappInstance });
  } catch (error: any) {
    console.error("[Instance Connect Error]", error.message || error);
    return res
      .status(500)
      .json({ error: "Erro ao reconectar a instância. Tente novamente." });
  }
};

// ============================================================================
// 3. 🔢 RECONEXÃO VIA CÓDIGO DE PAREAMENTO (NOVO MÉTODO)
// ============================================================================
export const connectNightclubWithCode = async (req: Request, res: Response) => {
  try {
    const { nightclubId, number } = req.body;

    if (!nightclubId || !number)
      return res.status(400).json({ error: "ID e número são obrigatórios." });

    const nightclub = await prisma.nightclub.findUnique({
      where: { id: nightclubId as string },
    });
    if (!nightclub)
      return res.status(404).json({ error: "Balada não encontrada." });

    const instanceName = `balada_${nightclub.slug}`;
    console.log(
      `\n[Instance] 🔢 Iniciando Pairing Code para: ${instanceName} / Número: ${number}`,
    );

    await forcarDesconexao(instanceName);

    try {
      console.log(`[Instance] 🏗️ Reconstruindo a instância na Evolution...`);
      await criarInstancia(instanceName);
    } catch (e: any) {
      console.log(
        `[Instance] ℹ️ Aviso (ignorável): Instância já existia. Seguindo...`,
      );
    }

    const webhookUrl =
      process.env.WEBHOOK_URL ||
      "http://host.docker.internal:3001/evolution/webhook";
    await configurarWebhook(instanceName, webhookUrl);

    const evolutionResponse = await conectarInstanciaComCodigo(
      instanceName,
      number,
    );

    console.log(
      `[DEBUG] Resposta Bruta da Evolution:`,
      JSON.stringify(evolutionResponse),
    );

    if (
      evolutionResponse?.instance?.state === "open" ||
      evolutionResponse?.state === "open"
    ) {
      throw new Error(
        "A Evolution travou a sessão no estado 'open'. O cache está sendo limpo. Tente gerar novamente em 5 segundos.",
      );
    }

    // 🛑 A SOLUÇÃO: Pega o pairingCode PRIMEIRO!
    let pairingCode =
      evolutionResponse?.pairingCode ||
      evolutionResponse?.pairingCodeResponse?.code;

    // Se ele não achou o pairingCode, mas existe a propriedade 'code' com tamanho pequeno (8 dígitos), aí ele usa.
    if (
      !pairingCode &&
      evolutionResponse?.code &&
      evolutionResponse.code.length < 20
    ) {
      pairingCode = evolutionResponse.code;
    }

    if (!pairingCode) {
      console.error(
        `[CRÍTICO] A Evolution devolveu a matriz do QR Code mas escondeu os 8 dígitos!`,
      );
      throw new Error(
        "Evolution não retornou o código de pareamento. Verifique se o número possui WhatsApp ativo e se o DDD está correto.",
      );
    }

    await prisma.whatsappInstance.upsert({
      where: { instanceName },
      update: { status: "CONNECTING", qrCode: null },
      create: {
        instanceName,
        nightclubId: nightclub.id,
        status: "CONNECTING",
        qrCode: null,
      },
    });

    iniciarCronometroCancelamento(instanceName);

    console.log(`[Instance] ✅ Código de Pareamento gerado: ${pairingCode}`);

    return res.status(200).json({ success: true, code: pairingCode });
  } catch (error: any) {
    console.error("[Instance Connect Code Error]", error.message || error);
    return res.status(500).json({
      error:
        error.message ||
        "Erro ao gerar código de pareamento. Verifique o console.",
    });
  }
};
