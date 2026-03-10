import { Request, Response } from "express";
import { prisma } from "../lib/prisma";
import { processarMensagemIA } from "../services/gemini.service";

export const handleEvolutionWebhook = async (req: Request, res: Response) => {
  try {
    const body = req.body;

    // A Evolution API envia eventos diferentes. Focamos apenas no evento de mensagens recebidas
    if (body.event !== "messages.upsert") {
      return res.status(200).send("Evento ignorado");
    }

    // Extrai o nome da instância (ex: upbar_123) e os dados da mensagem
    const instanceName = body.instance;
    const messageData = body.data;

    // Ignora mensagens enviadas pelo próprio bot ou mensagens de protocolo do sistema
    if (messageData.key.fromMe || messageData.message?.protocolMessage) {
      return res.status(200).send("Mensagem própria ignorada");
    }

    // Extrai o texto da mensagem da estrutura JSON da Evolution
    const textMessage =
      messageData.message?.conversation ||
      messageData.message?.extendedTextMessage?.text;

    if (!textMessage) {
      return res.status(200).send("Mensagem sem texto ignorada");
    }

    // 1. Busca a instância no banco de dados e traz as configurações da balada e da IA junto (baseado no schema que você enviou)
    const whatsappInstance = await prisma.whatsappInstance.findUnique({
      where: { instanceName },
      include: {
        nightclub: {
          include: {
            aiAgent: true,
          },
        },
      },
    });

    if (!whatsappInstance) {
      console.log(
        `[Webhook] Instância ${instanceName} não encontrada no banco.`,
      );
      return res.status(404).send("Instância não encontrada");
    }

    const aiAgent = whatsappInstance.nightclub?.aiAgent;

    if (!aiAgent || !aiAgent.isActive) {
      console.log(
        `[Webhook] IA inativa ou não configurada para a instância ${instanceName}.`,
      );
      return res.status(200).send("IA inativa");
    }

    // 2. Envia a mensagem para o Gemini processar com o prompt correto daquela balada
    console.log(`[Webhook] Processando mensagem para ${instanceName}...`);

    const respostaIA = await processarMensagemIA(
      aiAgent.systemPrompt,
      textMessage,
    );

    // 3. Extrai a resposta da IA (A parte do Function Calling implementaremos depois de testar o texto simples)
    const textoResposta = respostaIA.text();
    console.log(`[Gemini] Resposta gerada:`, textoResposta);

    // TODO: No próximo passo vamos implementar o envio dessa 'textoResposta' de volta para o WhatsApp via Evolution API

    return res
      .status(200)
      .json({ success: true, message: "Processado com sucesso" });
  } catch (error) {
    console.error("[Webhook Error]", error);
    return res.status(500).json({ error: "Erro interno no servidor" });
  }
};
