import { createLogger } from "../lib/logger.js";
import { createShopifyOrder } from "./shopifyApi.js";

const logger = createLogger("syncInvoice");

function extractInvoice(payload) {
  return (
    payload?.notaFiscal ??
    payload?.notas?.nota ??
    payload?.invoice ??
    payload?.fatura ??
    payload
  );
}

function normalizeItems(invoice) {
  const rawItems = invoice?.itens?.item ?? invoice?.itens ?? invoice?.items ?? [];
  const items = Array.isArray(rawItems) ? rawItems : [rawItems];

  return items
    .map((item) => ({
      name: item.descricao ?? item.nome ?? "item",
      quantity: Number(item.qtde ?? item.quantidade ?? 1),
      price: Number(item.vlr_unitario ?? item.valor_unitario ?? item.preco ?? 0),
    }))
    .filter((line) => line.quantity > 0);
}

function buildShopifyOrder(invoice) {
  const order = {
    order: {
      line_items: normalizeItems(invoice),
      tags: "bling-sync",
    },
  };

  if (invoice.cliente?.nome) {
    const [firstName, ...rest] = invoice.cliente.nome.split(" ");
    order.order.customer = {
      first_name: firstName,
      last_name: rest.join(" "),
      email: invoice.cliente.email,
    };
  }

  return order;
}

async function reconcileShopifyOrder(invoice, shopifyOrder) {
  // TODO: map Bling nota fiscal status into Shopify order/fulfillment updates
  logger.info("Invoice event processed; reconciliation pending", {
    numero: invoice?.numero ?? invoice?.pedido?.numero,
    shopifyOrderId: shopifyOrder?.order?.id,
  });
}

export async function syncInvoiceFromBlingEvent(payload, meta = {}) {
  const eventType = meta.eventType ?? "invoice_change";
  const invoice = extractInvoice(payload);
  if (!invoice) {
    throw new Error("missing_invoice_payload");
  }

  const orderPayload = buildShopifyOrder(invoice);
  if (!orderPayload.order.line_items.length) {
    throw new Error("invoice_without_items");
  }

  const result = await createShopifyOrder(orderPayload);
  logger.info("Shopify order created from Bling invoice", {
    blingInvoiceId: invoice?.numero ?? invoice?.pedido?.numero,
    shopifyOrderId: result?.order?.id,
    eventType,
  });

  await reconcileShopifyOrder(invoice, result);
  return result;
}
