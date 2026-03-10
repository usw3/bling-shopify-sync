import { createLogger } from "../lib/logger.js";
import { createInvoice } from "./blingApi.js";

const logger = createLogger("syncOrder");

function extractOrder(payload) {
  return payload?.order ?? payload;
}

function formatCustomer(order) {
  const customer = order.customer ?? {};
  const name = `${customer.first_name ?? ""} ${customer.last_name ?? ""}`.trim();
  return {
    nome: name || "Shopify Customer",
    email: customer.email,
  };
}

function buildItems(order) {
  const rawItems = order.line_items ?? [];
  return rawItems.map((item, index) => ({
    codigo: item.sku ?? `${order.id ?? order.order_number ?? index}`,
    descricao: item.name ?? item.title ?? `item-${index}`,
    qtde: Number(item.quantity ?? 1),
    vlr_unitario: Number(item.price ?? 0),
  }));
}

function buildInvoicePayload(order) {
  return {
    pedido: {
      numero: order.order_number ?? order.name ?? order.id,
      data: order.created_at ?? new Date().toISOString(),
      cliente: formatCustomer(order),
      itens: { item: buildItems(order) },
    },
  };
}

export async function syncOrderFromShopifyEvent(payload, meta = {}) {
  const order = extractOrder(payload);
  if (!order) {
    throw new Error("missing_order_payload");
  }

  if (meta.eventType === "orders/cancelled") {
    logger.info("Shopify order cancelled, skipping Bling invoice creation", {
      orderId: order.id,
      eventType: meta.eventType,
    });
    // TODO: notify Bling about cancellation or update existing nota fiscal
    return null;
  }

  const invoicePayload = buildInvoicePayload(order);
  const result = await createInvoice(invoicePayload);
  logger.info("Invoice created in Bling", {
    shopifyOrderId: order.id,
    blingOrderNumber: result?.retorno?.notasFiscais?.notaFiscal?.numero ?? result?.retorno?.pedido?.numero,
    eventType: meta.eventType,
  });
  return result;
}
