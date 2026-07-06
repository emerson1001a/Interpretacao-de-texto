# Interpretacao de Texto

Aplicativo HTML para atividades de interpretacao de texto.

## Como abrir localmente

1. Copie `.env.example` para `.env`.
2. Coloque sua chave da OpenAI em `OPENAI_API_KEY`.
3. Rode:

```bat
npm install
npm start
```

Depois acesse:

```text
http://localhost:3001/index.html
```

No Windows, tambem e possivel usar o arquivo `iniciar_interpretacao.bat`.

## Publicacao

O arquivo `index.html` foi incluido como copia de `interpretacao.html` para que GitHub Pages, Vercel ou outro servico de hospedagem estatica consigam abrir o aplicativo automaticamente.

## Observacao sobre o ChatGPT

Este repositorio agora tem backend proprio em `server.js`. Ele nao depende do projeto `RedacaoMiguelGPT`.

As funcoes com ChatGPT usam a variavel `OPENAI_API_KEY`. Se ela nao estiver configurada, o app usa respostas locais simples para a atividade continuar funcionando.
