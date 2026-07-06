# Interpretacao de Texto

Aplicativo HTML para atividades de interpretacao de texto.

## Como abrir localmente

Abra o arquivo `interpretacao.html` no navegador ou use o arquivo `iniciar_interpretacao.bat` no Windows.

## Publicacao

O arquivo `index.html` foi incluido como copia de `interpretacao.html` para que GitHub Pages, Vercel ou outro servico de hospedagem estatica consigam abrir o aplicativo automaticamente.

## Observacao sobre o ChatGPT

As telas chamam um backend local em `http://localhost:3000`, ligado ao projeto `RedacaoMiguelGPT`. Por isso, ao abrir o site hospedado publicamente, as funcoes que dependem do ChatGPT/backend so vao funcionar se esse backend tambem estiver publicado e a constante `API_BASE` for ajustada para a URL publica dele.
