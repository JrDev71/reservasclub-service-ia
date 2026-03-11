import { GoogleGenerativeAI } from "@google/generative-ai";
import axios from "axios";
import { prisma } from "../lib/prisma";
import { addDays, isAfter, isBefore, startOfDay, format } from "date-fns";

export class GeminiService {
  private genAI: GoogleGenerativeAI;
  private readonly MAIN_API_URL =
    process.env.MAIN_API_URL || "http://localhost:3000";
  private readonly MAIN_API_TOKEN = process.env.MAIN_API_TOKEN;

  private fallbackModels = [
    "gemini-2.0-flash",
    "gemini-2.5-flash",
    "gemini-2.0-flash-lite",
    "gemini-flash-latest",
    "gemini-1.5-flash",
    "gemini-pro-latest",
  ];

  constructor() {
    const apiKey = process.env.GEMINI_API_KEY;
    this.genAI = new GoogleGenerativeAI(apiKey || "");
  }

  private tools = [
    {
      functionDeclarations: [
        {
          name: "get_available_spaces",
          description:
            "Consulta quais setores estão disponíveis para uma data específica no banco de dados.",
          parameters: {
            type: "object",
            properties: {
              date: {
                type: "string",
                description: "Data da consulta (YYYY-MM-DD)",
              },
            },
            required: ["date"],
          },
        },
        {
          name: "create_reservation",
          description:
            "Cria a reserva no sistema e gera o código de pagamento PIX.",
          parameters: {
            type: "object",
            properties: {
              customerName: { type: "string", description: "Nome completo" },
              customerPhone: {
                type: "string",
                description: "Telefone com DDD",
              },
              customerEmail: {
                type: "string",
                description: "E-mail obrigatório",
              },
              date: { type: "string", description: "Data (YYYY-MM-DD)" },
              spaceName: {
                type: "string",
                description: "Nome do setor (ex: Camarote 1)",
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
      ],
    },
  ];

  async generateResponse(
    nightclubId: string,
    customerPhone: string,
    message: string,
  ) {
    try {
      const responseMain = await axios.get(
        `${this.MAIN_API_URL}/nightclubs/service-ia/${nightclubId}`,
        {
          headers: { "x-internal-key": this.MAIN_API_TOKEN },
        },
      );
      const nightclub = responseMain.data;
      if (!nightclub || !nightclub.aiAgent?.isActive) return null;

      const chatHistory = await prisma.aiMemory.findMany({
        where: { nightclubId, customerPhone },
        orderBy: { createdAt: "asc" },
        take: 12,
      });

      const formattedHistory = chatHistory.map((m) => ({
        role: m.role,
        parts: [{ text: m.content }],
      }));

      const baseHistory = [
        { role: "user", parts: [{ text: this.buildSystemContext(nightclub) }] },
        {
          role: "model",
          parts: [
            {
              text: "Assistente ReservasClub sincronizado. Operando com ferramentas de banco de dados.",
            },
          ],
        },
        ...formattedHistory,
      ];

      for (const modelName of this.fallbackModels) {
        try {
          const model = this.genAI.getGenerativeModel({
            model: modelName,
            tools: this.tools as any,
          });
          const chat = model.startChat({ history: baseHistory });

          let result = await chat.sendMessage(message);
          let chatResponse = result.response;
          let call = chatResponse.functionCalls()?.[0];

          while (call) {
            let functionResult = "";
            const args: any = call.args; // Cast para evitar erro TS

            if (call.name === "get_available_spaces") {
              functionResult = await this.getAvailableSpaces(
                nightclubId,
                args.date,
              );
            } else if (call.name === "create_reservation") {
              functionResult = await this.createReservationAndPayment(
                nightclubId,
                nightclub,
                args,
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
          }

          const responseText = chatResponse.text();

          await prisma.aiMemory.createMany({
            data: [
              { nightclubId, customerPhone, role: "user", content: message },
              {
                nightclubId,
                customerPhone,
                role: "model",
                content: responseText,
              },
            ],
          });

          return responseText;
        } catch (error: any) {
          console.warn(
            `⚠️ [Blindagem] Falha no ${modelName} (${error.message}). Tentando próximo...`,
          );
          continue;
        }
      }
      return "Estou com um problema técnico, mas já te retorno.";
    } catch (e) {
      return null;
    }
  }

  private async getAvailableSpaces(nightclubId: string, dateStr: string) {
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
      return "Nenhum setor disponível para esta data no banco de dados.";

    return (
      "Setores Disponíveis em " +
      dateStr +
      ":\n" +
      available.map((s) => `- ${s.name} (R$ ${s.price})`).join("\n")
    );
  }

  private async createReservationAndPayment(
    nightclubId: string,
    nightclub: any,
    args: any,
  ) {
    try {
      const date = startOfDay(new Date(args.date));
      const space = await prisma.space.findFirst({
        where: {
          nightclubId,
          name: { contains: args.spaceName, mode: "insensitive" },
          status: "ACTIVE",
        },
      });
      if (!space) return "Erro: Setor não encontrado no banco.";

      const check = await prisma.reservation.findFirst({
        where: {
          spaceId: space.id,
          date,
          status: { in: ["CONFIRMED", "PENDING"] },
        },
      });
      if (check) return "Erro: O setor " + space.name + " já está ocupado.";

      const customer = await prisma.customer.upsert({
        where: { email: args.customerEmail },
        update: { phone: args.customerPhone, name: args.customerName },
        create: {
          name: args.customerName,
          phone: args.customerPhone,
          email: args.customerEmail,
        },
      });

      // 🛡️ BLINDAGEM: Já criamos com um deadline de 20 minutos (padrão do ReservasClub)
      // Assim, se o PIX falhar, o seu Cron Job consegue cancelar a reserva!
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
          paymentDeadline: defaultDeadline, // 👈 O fim das reservas zumbis
        },
      });

      try {
        const pixResponse = await axios.post(
          `${this.MAIN_API_URL}/payments/generate-pix`,
          {
            reservationId: reservation.id,
            nightclubId: nightclubId,
          },
          { headers: { "x-internal-key": this.MAIN_API_TOKEN } },
        );

        return `SUCESSO! Reserva #${reservation.id.substring(0, 5)} criada para ${customer.name}. 
                CÓDIGO PIX (COPIE E COLE):
                ${pixResponse.data.pixCode}
                
                O seu ingresso será enviado automaticamente após o pagamento.`;
      } catch (err) {
        return "Reserva registrada, mas houve um erro ao gerar o PIX. Um atendente enviará o código manualmente em instantes.";
      }
    } catch (e: any) {
      return "Erro: " + e.message;
    }
  }

  private buildSystemContext(nightclub: any) {
    return `
      VOCÊ É O GERENTE DE VENDAS DA ${nightclub.name.toUpperCase()}.
      HOJE É: ${format(new Date(), "yyyy-MM-dd")}.

      REGRAS DE OURO:
      1. Use 'get_available_spaces' ANTES de oferecer qualquer setor.
      2. NUNCA diga que enviou algo por e-mail.
      3. Quando a ferramenta 'create_reservation' retornar o código PIX, EXIBA-O INTEGRALMENTE para o cliente copiar.
      4. Se o PIX for gerado, informe que o QR Code do ingresso será enviado por aqui mesmo após o pagamento.
      5. Formatação: Use *asteriscos* para negrito. Sem títulos #.

      CONTEXTO DA BALADA:
      ${nightclub.aiAgent?.systemPrompt || "Seja focado em converter a venda."}
    `;
  }
}
