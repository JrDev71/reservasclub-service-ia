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
      console.error(
        "❌ [GeminiService]: GEMINI_API_KEY não encontrada no Render!",
      );
    }
    this.genAI = new GoogleGenerativeAI(apiKey || "");
  }

  /**
   * 🛠️ Definição das Ferramentas (Tools) que a IA pode usar
   */
  private tools = [
    {
      functionDeclarations: [
        {
          name: "create_reservation",
          description:
            "Cria uma nova reserva validando disponibilidade e regras da casa.",
          parameters: {
            type: "object",
            properties: {
              customerName: {
                type: "string",
                description: "Nome completo do cliente",
              },
              customerPhone: {
                type: "string",
                description: "Telefone (apenas números)",
              },
              customerEmail: {
                type: "string",
                description: "E-mail (opcional)",
              },
              date: {
                type: "string",
                description: "Data da reserva (YYYY-MM-DD)",
              },
              spaceName: {
                type: "string",
                description: "Nome do setor (ex: Camarote 1)",
              },
            },
            required: ["customerName", "customerPhone", "date", "spaceName"],
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
      // 1. Busca dados da balada na ROTA VIP de serviço
      console.log(
        `[GeminiService] Consultando rota VIP: ${this.MAIN_API_URL}/nightclubs/service-ia/${nightclubId}`,
      );

      const responseMain = await axios
        .get(`${this.MAIN_API_URL}/nightclubs/service-ia/${nightclubId}`, {
          headers: {
            "x-internal-key": this.MAIN_API_TOKEN,
          },
        })
        .catch((err) => {
          throw new Error(
            `Falha na Main API (${err.response?.status || "OFFLINE"}): ${err.message}`,
          );
        });

      const nightclub = responseMain.data;

      if (!nightclub || !nightclub.aiAgent?.isActive) {
        console.warn(`[GeminiService] Balada ${nightclubId} sem agente ativo.`);
        return null;
      }

      // 2. Configura o modelo (Usando o 'latest' que validamos no scanner)
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
                text: "Assistente ReservasClub ativo. Validação de banco sincronizada.",
              },
            ],
          },
        ],
      });

      // 3. Processa a mensagem
      const result = await chat.sendMessage(message);
      const chatResponse = result.response;
      const call = chatResponse.functionCalls()?.[0];

      // 4. Se a IA decidir criar uma reserva
      if (call && call.name === "create_reservation") {
        const args: any = call.args;
        console.log(
          `[GeminiService] IA disparando ferramenta de reserva:`,
          args,
        );

        const reservationResult = await this.validateAndCreate(
          nightclubId,
          nightclub,
          args,
        );

        const finalResponse = await chat.sendMessage([
          {
            functionResponse: {
              name: "create_reservation",
              response: { content: reservationResult },
            },
          },
        ]);

        return finalResponse.response.text();
      }

      return chatResponse.text();
    } catch (error: any) {
      console.error("❌ [GeminiService Error]:", error.message);
      if (error.message.includes("429")) {
        return "Desculpe, estou recebendo muitas mensagens. Pode tentar novamente em um minuto?";
      }
      return null;
    }
  }

  /**
   * 🔍 Validação Pesada e Criação de Reserva
   */
  private async validateAndCreate(
    nightclubId: string,
    nightclub: any,
    args: any,
  ) {
    try {
      const requestedDate = startOfDay(new Date(args.date));
      const today = startOfDay(new Date());

      // Validação de Antecedência
      const settings = nightclub.settings || {};
      const maxDays = settings.reservationLeadTimeDays || 30;
      const limitDate = addDays(today, maxDays);

      if (isBefore(requestedDate, today))
        return "Erro: Não aceitamos reservas para datas passadas.";
      if (isAfter(requestedDate, limitDate))
        return `Erro: Reservas permitidas apenas para os próximos ${maxDays} dias.`;

      // Busca o Setor (Space)
      const space = await prisma.space.findFirst({
        where: {
          nightclubId,
          name: { contains: args.spaceName, mode: "insensitive" },
          status: "ACTIVE",
        },
      });

      if (!space)
        return `Erro: O setor '${args.spaceName}' não foi encontrado.`;

      // Check de Disponibilidade
      const existing = await prisma.reservation.findFirst({
        where: {
          spaceId: space.id,
          date: requestedDate,
          status: { in: ["CONFIRMED", "PENDING"] },
        },
      });

      if (existing)
        return `Erro: O ${space.name} já está reservado para esta data.`;

      // CRM: Upsert Cliente
      const customer = await prisma.customer.upsert({
        where: {
          email:
            args.customerEmail || `user-${args.customerPhone}@reservas.com`,
        },
        update: { phone: args.customerPhone, name: args.customerName },
        create: {
          name: args.customerName,
          phone: args.customerPhone,
          email:
            args.customerEmail || `user-${args.customerPhone}@reservas.com`,
        },
      });

      // Cria a Reserva
      const reservation = await prisma.reservation.create({
        data: {
          nightclubId,
          spaceId: space.id,
          customerId: customer.id,
          customerName: args.customerName,
          customerPhone: args.customerPhone,
          customerEmail: customer.email,
          date: requestedDate,
          amount: space.price,
          status: "PENDING",
        },
      });

      return `Sucesso! Reserva #${reservation.id.substring(0, 5)} criada para ${args.customerName}. O link de pagamento será gerado em seguida.`;
    } catch (error: any) {
      return `Erro ao processar reserva: ${error.message}`;
    }
  }

  /**
   * 🧠 Constrói o contexto dinâmico da balada (Personalidade SaaS)
   */
  private buildSystemContext(nightclub: any) {
    const spaces = (nightclub.spaces || [])
      .map((s: any) => `- ${s.name}: R$ ${s.price}`)
      .join("\n");

    return `
      VOCÊ É O AGENTE DE ATENDIMENTO DA ${nightclub.name.toUpperCase()}.
      HOJE É: ${format(new Date(), "yyyy-MM-dd")}.

      SETORES DISPONÍVEIS:
      ${spaces}

      REGRAS DE FORMATAÇÃO (WHATSAPP):
      - Use apenas *asteriscos* para negrito.
      - Não use títulos com #, use apenas negrito.
      - Respostas curtas, separadas por quebras de linha.
      - Use a ferramenta 'create_reservation' apenas quando tiver Nome, Telefone, Data e Setor.

      PERSONALIDADE DEFINIDA PELO DONO DA BALADA:
      ${nightclub.aiAgent?.systemPrompt || "Seja cordial e ajude com as reservas."}
    `;
  }
}
