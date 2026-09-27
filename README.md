# Super Client Web & Bot Moderador SuperLive

Sistema completo de Dashboard Web e Robô Moderador automatizado para transmissões do **SuperLive**, com conexão direta via WebSocket oficial e Proxy REST sem restrições de CORS.

---

## 🚀 Funcionalidades Principais

- **Robô Moderador & Vigilante**: Detecta automaticamente quando a sua live entra ao vivo e assume o posto de moderação.
- **Conexão WebSocket em Tempo Real**: Conexão com `wss://ws.sprlv-api.com` com suporte contínuo via Device-ID e autenticação token.
- **Fila de Mensagens & Avisos Periódicos**: Ciclo de anúncios automáticos na live com contador regressivo em tempo real.
- **Console Central de Logs & Diagnóstico**: Histórico completo de eventos, chamadas de rede, ações de moderação e captura de erros com filtros e exportação.
- **Resumo Estatístico Pós-Live na DM**: Envio de mensagem privada automática para o perfil da criadora com diamantes, pico de espectadores e tempo de live.
- **Preview Flutuante no Cantinho (Widget)**: Mini-player com dados da transmissão e feed do chat em tempo real.

---

## 🛠️ Como Rodar Localmente

**Requisitos:** Node.js 20 ou superior.

```bash
git clone https://github.com/geffinh0/botchat.git
cd botchat
npm install
npm start
```

O projeto declara `ws` como dependência porque o motor do robô usa WebSocket. Em Node 22+ há também fallback para o WebSocket nativo.

A autenticação não usa mais token embutido no código do frontend. Faça login pelo painel ou configure `SUPERLIVE_BOT_TOKEN`/`SUPERLIVE_DEVICE_ID` como variáveis de ambiente quando quiser iniciar o servidor com uma sessão pré-configurada.

Acesse no navegador: `http://localhost:3000`

---

## ☁️ Como Fazer Deploy Gratuito no Render (Passo a Passo)

1. Acesse o [Render Dashboard](https://dashboard.render.com/) e faça login (pode ser com a sua conta do GitHub).
2. Clique no botão azul **"New +"** no canto superior direito e selecione **"Web Service"**.
3. Selecione a opção **"Build and deploy from a Git repository"** e clique em **Next**.
4. Conecte sua conta do GitHub e escolha o repositório `geffinh0/botchat`.
5. Preencha as configurações do serviço:
   - **Name**: `superclient-bot` (ou o nome que preferir)
   - **Region**: `Ohio (US East)` ou `Frankfurt`
   - **Branch**: `main`
   - **Root Directory**: Deixe em branco
   - **Runtime**: `Node`
   - **Build Command**: `npm install` (ou deixe vazio, pois o projeto usa módulos nativos do Node)
   - **Start Command**: `node server.js`
   - **Instance Type**: Selecione **Free**
6. Clique no botão **"Create Web Service"**.
7. Em cerca de 30 a 60 segundos o Render irá gerar uma URL pública segura (ex: `https://superclient-bot.onrender.com`).
8. Pronto! Agora qualquer pessoa autorizada ou você mesmo pode acessar o robô e testar de qualquer lugar (computador, celular ou tablet).

### 🔎 Configuração recomendada de Health Check no Render

O servidor aceita a porta fornecida automaticamente pelo Render através de `process.env.PORT` e faz bind em `0.0.0.0`. Não é necessário definir `PORT=3000` no Render.

No painel do Web Service, em **Health Check Path**, use:

```text
/healthz
```

Esse endpoint retorna HTTP `200` enquanto o processo HTTP estiver ativo e pode ser usado pelo Render para verificar a saúde do serviço.

O servidor também registra explicitamente as etapas de inicialização no log e trata `SIGTERM`, `uncaughtException`, `unhandledRejection` e erros do listener HTTP para facilitar o diagnóstico de falhas de deploy.
