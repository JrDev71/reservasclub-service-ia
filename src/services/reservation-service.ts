import axios from "axios";
import { prisma } from "../lib/prisma";
import { startOfDay, format } from "date-fns";

export class ReservationService {
  private readonly MAIN_API_URL =
    process.env.MAIN_API_URL || "http://localhost:3000";
  private readonly MAIN_API_TOKEN = process.env.MAIN_API_TOKEN;

  async getAvailableSpaces(
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

  async createReservationAndPayment(
    nightclubId: string,
    args: any,
    requestId: string,
    customerPhone: string,
  ) {
    // 🎂 Log atualizado para já mostrar no terminal se a IA captou o aniversário
    console.log(
      `[${requestId}] 📝 Criando reserva para ${args.customerName}. Aniversário: ${args.isBirthday ? "SIM" : "NÃO"}`,
    );

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

      // =======================================================
      // 🎂 INTELIGÊNCIA DE PRECIFICAÇÃO (FASE 3)
      // =======================================================
      const isBirthdayParty = args.isBirthday === true;

      // Se for aniversário E o espaço tiver um preço de aniversário cadastrado, cobra mais barato.
      // Caso contrário (se for false ou se o preço de aniversário for null), cobra o valor cheio.
      const finalAmount =
        isBirthdayParty && space.birthdayPrice !== null
          ? space.birthdayPrice
          : space.price;

      // ⏳ O TEMPO DE BLOQUEIO DA MESA (Missão de 5 minutos cumprida!)
      const defaultDeadline = new Date(new Date().getTime() + 5 * 60000);

      const reservation = await prisma.reservation.create({
        data: {
          nightclubId,
          spaceId: space.id,
          customerId: customer.id,
          customerName: customer.name,
          customerPhone: customer.phone,
          customerEmail: customer.email,
          date,

          amount: finalAmount, // 👈 O preço inteligente aplicado!
          isBirthday: isBirthdayParty, // 👈 Marcando a flag de aniversário oficial no banco

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
      const checkoutLink = `https://reservasclub.com.br/checkout/${reservation.id}`;

      return `RESERVA CRIADA COM SUCESSO!
      
1. Código PIX Copia e Cola: ${pixCode}
2. Link do Checkout: ${checkoutLink}

INSTRUÇÕES FINAIS PARA A IA: Repasse o Copia e Cola e a URL do Link do Checkout como TEXTO PURO. NUNCA use formatação markdown como [url](url). Apenas cole o link limpo.`;
    } catch (e: any) {
      console.error(`[${requestId}] 💥 Erro na criação: ${e.message}`);
      return "Erro no processo de PIX. Peça para o cliente aguardar.";
    }
  }
}
