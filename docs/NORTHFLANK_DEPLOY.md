# Deploy no Northflank

Este serviço não precisa de ngrok quando estiver no Northflank. O domínio
público gerado pelo serviço passa a ser o endereço permanente para OAuth e
webhooks.

## 1. Criar o serviço

1. Envie o repositório para o GitHub, sem incluir `.env` ou
   `.bling-token-cache.json`.
2. No Northflank, crie um **Project** e depois um **Service** contínuo a partir
   do repositório.
3. Selecione o `Dockerfile` da raiz como método de build. O comando de runtime
   é o já definido pela imagem: `npm start`.
4. Exponha a porta HTTP `3000` publicamente e gere um domínio Northflank
   (ou conecte um domínio próprio). O app também aceita uma porta diferente
   por meio de `PORT`, que o Northflank pode definir.
5. Configure um health check HTTP: método `GET`, caminho `/health`, porta do
   serviço. A resposta esperada é `200` com `{ "status": "ok" }`.

O Northflank pode construir imagens a partir de repositórios Git e executar
serviços continuamente; o health check impede que tráfego seja direcionado a
uma instância não saudável. Consulte a documentação do Northflank para
serviços e health checks antes de alterar a configuração:

- [Serviços contínuos](https://northflank.com/docs/v1/application/run/run-containers-and-micro-services)
- [Health checks](https://northflank.com/docs/v1/application/observe/configure-health-checks)
- [Expor uma aplicação](https://northflank.com/docs/v1/application/network/expose-your-application)

## 2. Variáveis de ambiente

Cadastre estas variáveis como secrets no Northflank, com os mesmos valores do
arquivo `.env` local. Nunca cole os valores em arquivos versionados ou logs.

```text
BLING_CLIENT_ID
BLING_CLIENT_SECRET
BLING_ACCESS_TOKEN
BLING_REFRESH_TOKEN
BLING_WEBHOOK_SECRET
SHOPIFY_STORE
SHOPIFY_CLIENT_ID
SHOPIFY_CLIENT_SECRET
SHOPIFY_WEBHOOK_SECRET
SHOPIFY_API_VERSION=2026-01
```

Variáveis opcionais usadas por este repositório, quando aplicáveis:

```text
BLING_API_BASE
BLING_API_URL
BLING_TOKEN_STORE_PATH
SHOPIFY_LOCATION_ID
SHOPIFY_COMPLEMENT_TYPE
```

Não defina `BLING_OAUTH_DEBUG=1` em produção: essa opção retorna tokens no
callback OAuth para diagnóstico local.

## 3. Validar antes da troca

Com `https://SEU-DOMINIO` substituído pelo domínio do Northflank:

```bash
curl --fail https://SEU-DOMINIO/health
curl --fail https://SEU-DOMINIO/
```

O primeiro comando deve retornar HTTP 200. Confirme também os logs do serviço
após cada chamada.

## 4. Trocar as integrações externas

Somente depois de a validação passar, altere no Bling:

| Uso | URL nova |
| --- | --- |
| Redirect URI OAuth | `https://SEU-DOMINIO/bling/oauth` |
| Webhook de produtos | `https://SEU-DOMINIO/webhooks/bling/products` |
| Webhook de notas, se usado | `https://SEU-DOMINIO/webhooks/bling/invoices` |

Se os webhooks Shopify de pedidos estiverem habilitados, atualize-os também:

```text
https://SEU-DOMINIO/webhooks/shopify/orders-create
https://SEU-DOMINIO/webhooks/shopify/orders-updated
https://SEU-DOMINIO/webhooks/shopify/orders-cancelled
```

Faça uma alteração de produto de teste no Bling e confira o log do Northflank
e o produto correspondente na Shopify. Mantenha o ngrok ativo apenas até esse
teste funcionar; então remova as URLs `*.ngrok-free.dev` cadastradas no Bling.

## Observação sobre tokens Bling

O estado atual armazena o cache de token em memória e, quando configurado, em
arquivo local. O sistema de arquivos do container deve ser tratado como
efêmero. Cadastre `BLING_REFRESH_TOKEN` como secret e, antes de mover para
múltiplas lojas, implemente persistência criptografada em banco conforme o
PRD.
