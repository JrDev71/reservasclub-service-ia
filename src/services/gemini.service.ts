import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";
import { prisma } from "../lib/prisma";
import { startOfDay, format } from "date-fns";
import { enviarMediaWhatsApp } from "./evolution.service";

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private readonly MAIN_API_URL =
    process.env.MAIN_API_URL || "http://localhost:3000";
  private readonly MAIN_API_TOKEN = process.env.MAIN_API_TOKEN;

  private fallbackModels = [
    "gemini-2.5-flash",
    "gemini-1.5-flash",
    "gemini-flash-latest",
  ];

  constructor() {
    this.genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY || "");
  }

  private tools = [
    {
      functionDeclarations: [
        {
          name: "get_available_spaces",
          description: "Consulta setores disponíveis para uma data específica.",
          parameters: {
            type: "object",
            properties: {
              date: {
                type: "string",
                description: "A data no formato AAAA-MM-DD",
              },
            },
            required: ["date"],
          },
        },
        {
          name: "create_reservation",
          description: "Cria reserva e gera PIX.",
          parameters: {
            type: "object",
            properties: {
              customerName: { type: "string" },
              customerPhone: { type: "string" },
              customerEmail: { type: "string" },
              date: {
                type: "string",
                description: "A data no formato AAAA-MM-DD",
              },
              spaceName: { type: "string" },
            },
            required: [
              "customerName",
              "customerPhone",
              "customerEmail",
              "date",
              "spaceName",
            ],
          },
        },
      ],
    },
  ];

  async generateResponse(
    nightclubId: string,
    customerPhone: string,
    message: string,
  ) {
    const requestId = Math.random().toString(36).substring(7).toUpperCase();
    console.log(
      `\n[${requestId}] 📨 NOVA MENSAGEM: ${customerPhone} -> "${message}"`,
    );

    try {
      const responseMain = await axios.get(
        `${this.MAIN_API_URL}/nightclubs/service-ia/${nightclubId}`,
        {
          headers: { "x-internal-key": this.MAIN_API_TOKEN },
        },
      );
      const nightclub = responseMain.data;
      if (!nightclub?.aiAgent?.isActive) {
        console.warn(
          `[${requestId}] ⚠️ Agente inativo ou balada não encontrada.`,
        );
        return null;
      }

      const systemContext = this.buildSystemContext(nightclub);

      const rawHistory = await prisma.aiMemory.findMany({
        where: { nightclubId, customerPhone },
        orderBy: { createdAt: "desc" },
        take: 12,
      });

      rawHistory.reverse();

      let formattedHistory = rawHistory.map((m) => ({
        role: m.role === "assistant" ? "model" : m.role,
        parts: [{ text: m.content }],
      }));

      while (
        formattedHistory.length > 0 &&
        formattedHistory[0].role !== "user"
      ) {
        formattedHistory.shift();
      }

      let lastErrorType = "";

      for (const modelName of this.fallbackModels) {
        try {
          console.log(`[${requestId}] 🧠 Tentando modelo: ${modelName}`);

          const model = this.genAI.getGenerativeModel({
            model: modelName,
            systemInstruction: systemContext,
            tools: this.tools as any,
          });

          const chat = model.startChat({ history: formattedHistory });

          let result = await chat.sendMessage(message);
          let chatResponse = result.response;
          let call = chatResponse.functionCalls()?.[0];
          let finalResponseText = chatResponse.text() || "";

          while (call) {
            console.log(`[${requestId}] 🛠️ IA usou: ${call.name}`);
            const args: any = call.args;
            let functionResult = "";

            if (call.name === "get_available_spaces") {
              functionResult = await this.getAvailableSpaces(
                nightclubId,
                args.date,
                requestId,
              );
            } else if (call.name === "create_reservation") {
              functionResult = await this.createReservationAndPayment(
                nightclubId,
                nightclub,
                args,
                requestId,
                customerPhone,
              );
            }

            const nextStep = await chat.sendMessage([
              {
                functionResponse: {
                  name: call.name,
                  response: { content: functionResult },
                },
              },
            ]);

            chatResponse = nextStep.response;
            call = chatResponse.functionCalls()?.[0];

            if (!call) {
              finalResponseText = chatResponse.text();
            }
          }

          await prisma.aiMemory.createMany({
            data: [
              { nightclubId, customerPhone, role: "user", content: message },
              {
                nightclubId,
                customerPhone,
                role: "model",
                content: finalResponseText,
              },
            ],
          });

          console.log(`[${requestId}] ✅ SUCESSO (${modelName})`);
          return finalResponseText;
        } catch (error: any) {
          const isQuota =
            error.message.includes("429") || error.message.includes("Quota");
          if (isQuota) lastErrorType = "QUOTA_EXCEEDED";

          console.warn(
            `[${requestId}] ⚠️ Falha no ${modelName}: ${isQuota ? "Cota estourada (429)" : error.message.split("\n")[0]}`,
          );
          continue;
        }
      }

      if (lastErrorType === "QUOTA_EXCEEDED") {
        console.error(
          `[${requestId}] 🚨 ALERTA CRÍTICO: Todas as tentativas falharam por falta de cota no Google API.`,
        );
      }
      return "Estou com uma fila de espera grande no momento. Pode me enviar um 'Oi' novamente em 1 minuto?";
    } catch (e: any) {
      console.error(`[${requestId}] 🚨 ERRO SISTÊMICO: ${e.message}`);
      return null;
    }
  }

  private async getAvailableSpaces(
    nightclubId: string,
    dateStr: string,
    requestId: string,
  ) {
    try {
      const date = startOfDay(new Date(dateStr));
      const allSpaces = await prisma.space.findMany({
        where: { nightclubId, status: "ACTIVE" },
      });
      const occupiedReservations = await prisma.reservation.findMany({
        where: { nightclubId, date, status: { in: ["CONFIRMED", "PENDING"] } },
        select: { spaceId: true },
      });
      const occupiedIds = occupiedReservations.map((r) => r.spaceId);
      const available = allSpaces.filter((s) => !occupiedIds.includes(s.id));

      if (available.length === 0)
        return "Nenhum setor disponível para esta data.";
      return (
        "Disponíveis para esta data: " +
        available.map((s) => `${s.name} (R$${s.price})`).join(", ")
      );
    } catch (error) {
      return "Erro ao ler a data. Peça ao cliente para fornecer a data exata.";
    }
  }

  private async createReservationAndPayment(
    nightclubId: string,
    nightclub: any,
    args: any,
    requestId: string,
    customerPhone: string,
  ) {
    console.log(`[${requestId}] 📝 Criando reserva para ${args.customerName}`);
    try {
      const date = startOfDay(new Date(args.date));

      const space = await prisma.space.findFirst({
        where: {
          nightclubId,
          name: { contains: args.spaceName, mode: "insensitive" },
          status: "ACTIVE",
        },
      });
      if (!space)
        return "Erro: Setor inexistente. Verifique os setores disponíveis com a função get_available_spaces.";

      // 🛑 ESCUDO ANTI-OVERBOOKING
      const isOccupied = await prisma.reservation.findFirst({
        where: {
          nightclubId,
          spaceId: space.id,
          date: date,
          status: { in: ["CONFIRMED", "PENDING"] },
        },
      });

      if (isOccupied) {
        console.warn(
          `[${requestId}] 🛑 Bloqueado Overbooking! IA tentou reservar o ${space.name} mas já estava ocupado.`,
        );
        return `ERRO CRÍTICO: O setor "${space.name}" já foi reservado ou está aguardando pagamento para o dia ${format(date, "dd/MM/yyyy")}. Informe o cliente gentilmente que este setor esgotou e ofereça as outras opções disponíveis (use a função get_available_spaces para ver quais sobraram).`;
      }

      const customer = await prisma.customer.upsert({
        where: { email: args.customerEmail },
        update: { phone: args.customerPhone, name: args.customerName },
        create: {
          name: args.customerName,
          phone: args.customerPhone,
          email: args.customerEmail,
        },
      });

      const defaultDeadline = new Date(new Date().getTime() + 20 * 60000);
      const reservation = await prisma.reservation.create({
        data: {
          nightclubId,
          spaceId: space.id,
          customerId: customer.id,
          customerName: customer.name,
          customerPhone: customer.phone,
          customerEmail: customer.email,
          date,
          amount: space.price,
          status: "PENDING",
          paymentDeadline: defaultDeadline,
        },
      });

      const pixResponse = await axios.post(
        `${this.MAIN_API_URL}/payments/generate-pix`,
        {
          reservationId: reservation.id,
          nightclubId: nightclubId,
        },
        { headers: { "x-internal-key": this.MAIN_API_TOKEN } },
      );

      const pixCode = pixResponse.data.pixCode;
      const base64Image = pixResponse.data.qrCodeBase64;

      const checkoutLink = `https://reservasclub.com.br/checkout/${reservation.id}`;

      if (base64Image && base64Image.length > 50) {
        try {
          const instance = await prisma.whatsappInstance.findFirst({
            where: { nightclubId, status: { in: ["CONNECTED", "OPEN"] } },
            orderBy: { createdAt: "desc" },
          });

          if (instance) {
            const safeNumber = customerPhone.replace("@s.whatsapp.net", "");

            console.log(
              `[${requestId}] 📸 Disparando Imagem do QR Code PIX para ${safeNumber}`,
            );
            await enviarMediaWhatsApp(
              instance.instanceName,
              safeNumber,
              base64Image,
              "Seu QR Code para pagamento",
            );
          }
        } catch (mediaError: any) {
          console.error(
            `[${requestId}] ⚠️ Erro ao enviar imagem do QR Code:`,
            mediaError.message,
          );
        }
      }

      return `RESERVA CRIADA COM SUCESSO!
      
1. Código PIX Copia e Cola: ${pixCode}
2. Link do Checkout (para acompanhar ou pagar com cartão): ${checkoutLink}

Diga ao cliente que a imagem do QR Code já foi enviada acima. Repasse o Copia e Cola e o Link do Checkout.`;
    } catch (e: any) {
      console.error(`[${requestId}] 💥 Erro na criação: ${e.message}`);
      return "Erro no processo de PIX. Peça para o cliente aguardar.";
    }
  }

  private buildSystemContext(nightclub: any) {
    const customPrompt =
      nightclub?.aiAgent?.systemPrompt ||
      "Você é um assistente virtual prestativo.";

    const dataDeHoje = format(new Date(), "dd/MM/yyyy");

    return `IDENTIDADE DO AGENTE:
${customPrompt}

-------------------
REGRAS OBRIGATÓRIAS DE ATENDIMENTO (NÃO QUEBRE SOB HIPÓTESE ALGUMA):
1. Você representa EXCLUSIVAMENTE a balada: ${nightclub.name}. NUNCA diga que é uma IA ou modelo do Google. Aja como humano 100% do tempo.
2. HOJE É DIA: ${dataDeHoje}. 
3. 🛑 ATENDIMENTO NATURAL: Se o cliente enviar apenas uma saudação (ex: "oi", "boa noite") ou fizer uma pergunta geral (ex: "qual a programação?", "onde fica?"), responda de forma educada usando a sua Identidade. NÃO inicie o fluxo de reserva, NÃO peça datas e NÃO chame funções sem ele pedir.
4. FLUXO DE RESERVA: SÓ chame a função 'get_available_spaces' SE o cliente perguntar o que tem disponível ou disser que quer reservar algo.
5. Nas chamadas de função, envie a data sempre no formato matemático AAAA-MM-DD.
6. APÓS usar 'get_available_spaces', responda ao cliente listando as opções e preços que você encontrou.
7. PARA FECHAR RESERVA: SÓ chame 'create_reservation' QUANDO o cliente escolher o setor. Peça o nome, email e telefone ANTES de criar.
8. APÓS usar 'create_reservation', entregue o código "Copia e Cola" PIX e o Link do Checkout na sua resposta de texto.
9. 🛑 O histórico contém o passado. SÓ crie uma reserva se o cliente pedir uma reserva NOVA na mensagem atual.`;
  }
}
