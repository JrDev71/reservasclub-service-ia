import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";
import { prisma } from "../lib/prisma";
import { addDays, isAfter, isBefore, startOfDay, format } from "date-fns";

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private readonly MAIN_API_URL =
    process.env.MAIN_API_URL || "http://localhost:3000";
  private readonly MAIN_API_TOKEN = process.env.MAIN_API_TOKEN;

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      console.error("❌ [GeminiService]: GEMINI_API_KEY não encontrada!");
    }
    this.genAI = new GoogleGenerativeAI(apiKey || "");
  }

  /**
   * 🛠️ Ferramentas (Tools) da IA: Criar e Cancelar Reservas
   */
  private tools = [
    {
      functionDeclarations: [
        {
          name: "create_reservation",
          description:
            "Cria uma nova reserva para o cliente e retorna as instruções de pagamento PIX.",
          parameters: {
            type: "object",
            properties: {
              customerName: {
                type: "string",
                description: "Nome completo do cliente",
              },
              customerPhone: {
                type: "string",
                description: "Telefone do cliente (apenas números)",
              },
              customerEmail: {
                type: "string",
                description: "E-mail válido do cliente",
              },
              date: {
                type: "string",
                description: "Data da reserva no formato YYYY-MM-DD",
              },
              spaceName: {
                type: "string",
                description: "Nome do setor desejado (ex: Camarote 1)",
              },
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
        {
          name: "cancel_reservation",
          description:
            "Cancela uma reserva existente pelo email ou telefone do cliente.",
          parameters: {
            type: "object",
            properties: {
              customerPhone: {
                type: "string",
                description: "Telefone do cliente (apenas números)",
              },
              date: {
                type: "string",
                description: "Data da reserva a ser cancelada (YYYY-MM-DD)",
              },
            },
            required: ["customerPhone", "date"],
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
    try {
      const responseMain = await axios
        .get(`${this.MAIN_API_URL}/nightclubs/service-ia/${nightclubId}`, {
          headers: { "x-internal-key": this.MAIN_API_TOKEN },
        })
        .catch((err) => {
          throw new Error(`Falha na Main API: ${err.message}`);
        });

      const nightclub = responseMain.data;

      if (!nightclub || !nightclub.aiAgent?.isActive) {
        return null;
      }

      const model = this.genAI.getGenerativeModel({
        model: "gemini-flash-latest",
        tools: this.tools as any,
      });

      const chat = model.startChat({
        history: [
          {
            role: "user",
            parts: [{ text: this.buildSystemContext(nightclub) }],
          },
          {
            role: "model",
            parts: [
              {
                text: "Compreendido. Operando com ferramentas de banco de dados sincronizadas.",
              },
            ],
          },
        ],
      });

      const result = await chat.sendMessage(message);
      const chatResponse = result.response;
      const call = chatResponse.functionCalls()?.[0];

      // 🔄 ROTEAMENTO DE FUNÇÕES DA IA
      if (call) {
        const args: any = call.args;
        let functionResult = "";

        if (call.name === "create_reservation") {
          console.log(`[GeminiService] IA criando reserva:`, args);
          functionResult = await this.validateAndCreate(
            nightclubId,
            nightclub,
            args,
          );
        } else if (call.name === "cancel_reservation") {
          console.log(`[GeminiService] IA cancelando reserva:`, args);
          functionResult = await this.cancelReservation(nightclubId, args);
        }

        const finalResponse = await chat.sendMessage([
          {
            functionResponse: {
              name: call.name,
              response: { content: functionResult },
            },
          },
        ]);

        return finalResponse.response.text();
      }

      return chatResponse.text();
    } catch (error: any) {
      console.error("❌ [GeminiService Error]:", error.message);
      if (error.message.includes("429")) {
        return "Desculpe, nosso sistema está com alta demanda. Aguarde um instante e tente novamente.";
      }
      return null;
    }
  }

  /**
   * 🛒 Criar Reserva e Preparar Pagamento
   */
  private async validateAndCreate(
    nightclubId: string,
    nightclub: any,
    args: any,
  ) {
    try {
      const requestedDate = startOfDay(new Date(args.date));
      const today = startOfDay(new Date());
      const maxDays = nightclub.settings?.reservationLeadTimeDays || 30;

      if (isBefore(requestedDate, today)) return "Falha: Data no passado.";
      if (isAfter(requestedDate, addDays(today, maxDays)))
        return `Falha: O limite de antecedência é ${maxDays} dias.`;

      const space = await prisma.space.findFirst({
        where: {
          nightclubId,
          name: { contains: args.spaceName, mode: "insensitive" },
          status: "ACTIVE",
        },
      });

      if (!space)
        return `Falha: Setor '${args.spaceName}' inexistente ou inativo.`;

      const existing = await prisma.reservation.findFirst({
        where: {
          spaceId: space.id,
          date: requestedDate,
          status: { in: ["CONFIRMED", "PENDING"] },
        },
      });

      if (existing)
        return `Falha: O ${space.name} já está reservado nesta data.`;

      // Cria ou atualiza o cliente (agora com o email obrigatório)
      const customer = await prisma.customer.upsert({
        where: { email: args.customerEmail },
        update: { phone: args.customerPhone, name: args.customerName },
        create: {
          name: args.customerName,
          phone: args.customerPhone,
          email: args.customerEmail,
        },
      });

      // Cria a reserva PENDENTE
      const reservation = await prisma.reservation.create({
        data: {
          nightclubId,
          spaceId: space.id,
          customerId: customer.id,
          customerName: customer.name,
          customerPhone: customer.phone,
          customerEmail: customer.email,
          date: requestedDate,
          amount: space.price,
          status: "PENDING", // Aguardando Webhook do MP confirmar
        },
      });

      // TODO: Aqui vamos disparar a requisição pro Mercado Pago gerar o PIX futuramente.
      // Por enquanto, retornamos a instrução simulada para a IA avisar o cliente.
      return `SUCESSO! Reserva #${reservation.id.substring(0, 5)} criada. 
      VALOR: R$ ${space.price}. 
      INSTRUÇÃO PARA O ASSISTENTE: Diga ao cliente que a reserva está pré-aprovada e que o setor financeiro enviará o código PIX e o ingresso QR Code em instantes pelo WhatsApp.`;
    } catch (error: any) {
      return `Erro no banco: ${error.message}`;
    }
  }

  /**
   * ❌ Cancelar Reserva
   */
  private async cancelReservation(nightclubId: string, args: any) {
    try {
      const targetDate = startOfDay(new Date(args.date));

      const reservation = await prisma.reservation.findFirst({
        where: {
          nightclubId,
          customerPhone: args.customerPhone,
          date: targetDate,
          status: { in: ["PENDING", "CONFIRMED"] },
        },
      });

      if (!reservation)
        return "Falha: Nenhuma reserva ativa encontrada para este telefone nesta data.";

      await prisma.reservation.update({
        where: { id: reservation.id },
        data: { status: "CANCELED" },
      });

      return "Sucesso! Reserva cancelada com êxito.";
    } catch (error: any) {
      return `Erro ao cancelar: ${error.message}`;
    }
  }

  /**
   * 🧠 Contexto do Sistema
   */
  private buildSystemContext(nightclub: any) {
    const spaces = (nightclub.spaces || [])
      .map((s: any) => `- ${s.name}: R$ ${s.price}`)
      .join("\n");

    return `
      VOCÊ É O AGENTE DE ATENDIMENTO DA ${nightclub.name.toUpperCase()}.
      HOJE É: ${format(new Date(), "yyyy-MM-dd")}.

      SETORES DISPONÍVEIS E PREÇOS:
      ${spaces}

      REGRAS ESTABELECIDAS:
      1. Para criar reserva, VOCÊ DEVE COLETAR EXPLICITAMENTE: Nome, Telefone, EMAIL e Setor.
      2. Se o cliente não informar o email, pergunte antes de acionar a ferramenta.
      3. Use formatação de WhatsApp (apenas *asteriscos* para negrito).

      COMPORTAMENTO BASE:
      ${nightclub.aiAgent?.systemPrompt || "Seja eficiente e cordial."}
    `;
  }
}
