# Votação ao vivo

Ferramenta de votação em tempo real (estilo Mentimeter) para eventos grandes: os participantes entram pelo
QR Code ou pelo link, votam pelo celular e o telão mostra as barras subindo ao vivo, o cronômetro, o vencedor
de cada pergunta e o resumo final.

Servidor único em Node.js, **sem dependências** (nada de `npm install`). Precisa de Node 18 ou mais novo.

## Rodar

```bash
node server.js
```

O terminal mostra os três endereços:

| Quem usa | Endereço | Para quê |
|---|---|---|
| Participantes | `/` | votam pelo celular (é o que o QR Code abre) |
| Telão | `/screen?key=SUA_CHAVE` | QR Code, barras ao vivo, cronômetro, vencedor |
| Apresentador | `/admin?key=SUA_CHAVE` | controle pelo celular ou por outro computador |

A chave de admin é gerada a cada início. Para fixar uma (recomendado), defina `ADMIN_KEY`:

```bash
ADMIN_KEY=uma-chave-longa node server.js
```

## Suas perguntas

As perguntas do evento "As Sete Esferas" já estão em `questions.json`. Formato (de 2 a 8 opções por pergunta;
o servidor avisa se algo estiver errado):

```json
{
  "title": "As Sete Esferas",
  "voteSeconds": 40,
  "questions": [
    {
      "title": "Título curto (vira o texto vertical no telão)",
      "text": "O enunciado completo da pergunta.",
      "options": ["Primeira alternativa", "Segunda", "Terceira", "Quarta"],
      "correct": 2
    }
  ]
}
```

`correct` é a posição da resposta certa (0 = A, 1 = B, 2 = C...). Ela **só é revelada quando a votação encerra**
(nunca é enviada aos celulares antes). Se omitir `correct`, a pergunta vira enquete e o destaque é só da opção mais votada.

## Como operar no evento

1. Abra o telão (`/screen?key=...`) no computador ligado ao projetor e aperte **F** para tela cheia.
   O QR Code e o contador de pessoas conectadas aparecem sozinhos.
2. Quando todos tiverem entrado, **Começar**: a pergunta 1 aparece (hora de lê-la em voz alta).
3. **Iniciar votação**: o cronômetro de 40 s corre no telão e nos celulares; as barras sobem em tempo real.
4. Ao zerar, a votação **encerra sozinha**: o telão marca a **resposta correta** (com o % de quem acertou) e a opção
   **mais votada**; no celular cada pessoa vê se acertou.
5. **Próxima pergunta**. Depois da última, aparece o resumo com o vencedor de cada pergunta.

Controles: botões que aparecem ao mexer o mouse no telão, ou o `/admin` no celular.
Atalhos no telão: **Espaço / Enter / →** = ação principal (começar, iniciar, encerrar, próxima),
**←** volta (antes de iniciar a votação), **F** tela cheia.
Também há **Refazer pergunta** (apaga os votos dela) e **Reiniciar tudo** — ambos pedem confirmação.

## Colocar no ar (grátis)

Os participantes precisam de um endereço público com HTTPS. O caminho gratuito que funciona para este projeto é o **Render**
(plano Free). Verificado em 17/10/2026; planos gratuitos mudam, confira antes do evento.

1. Crie um repositório no GitHub com esta pasta (pode ser privado).
2. No [Render](https://render.com): **New → Blueprint** (ele lê o `render.yaml` e já escolhe o plano Free) e aponte para o repositório.
   Sem Blueprint: **New → Web Service**, build `npm install`, start `node server.js`, instância **Free**.
3. Em **Environment**, adicione `ADMIN_KEY` com uma chave só de letras e números (12+ caracteres).
4. Quando terminar o deploy, abra o telão pelo endereço público: `https://SEU-APP.onrender.com/screen?key=SUA_CHAVE`.
   O QR Code já sai apontando para esse endereço.

Cuidados com o plano gratuito:

- **Hiberna após 15 min sem tráfego de entrada** e leva cerca de 1 min para acordar. O telão e o `/admin` fazem um ping a cada
  4 min enquanto abertos; mesmo assim, abra o telão uns 15 minutos antes e deixe aberto.
- **O Render pode reiniciar o serviço a qualquer momento** e o disco é temporário: se isso acontecer no meio do evento, a votação
  volta ao início. Por isso, faça o teste geral antes e use **Reiniciar tudo** para zerar antes de começar.
- **Banda**: 5 GB/mês de saída incluídos; o evento usa bem menos que isso (cada celular baixa cerca de 0,4 MB de imagens).

**O que não serve para este projeto:** o *quick tunnel* do Cloudflare (`cloudflared tunnel --url ...`) não suporta o tipo de conexão
em tempo real usado aqui (SSE) e limita 200 requisições simultâneas. A Vercel também não serve sem reescrever a arquitetura
(estado em memória e conexões longas). Railway tem só US$ 1/mês de crédito no plano Free (e um crédito único de US$ 5 no teste);
Fly.io não tem plano gratuito (uma máquina pequena custa cerca de US$ 2,19/mês, cobrada por segundo).

Se o endereço público for diferente do que o telão abre, defina `PUBLIC_URL=https://seu-endereco`.

## Configurações (variáveis de ambiente)

| Variável | Padrão | O que faz |
|---|---|---|
| `PORT` | 3000 | porta do servidor |
| `ADMIN_KEY` | aleatória | chave do telão com controles e do `/admin` |
| `PUBLIC_URL` | endereço aberto no telão | endereço que vai no QR Code |
| `VOTE_SECONDS` | 40 (ou o de `questions.json`) | duração de cada votação |
| `QUESTIONS_FILE` | `questions.json` | outro arquivo de perguntas |
| `STATE_FILE` | `data/state.json` | onde o andamento é salvo |

O andamento (fase, votos) é salvo em disco a cada 2 s: se o servidor reiniciar no meio do evento, ele continua
de onde parou (e se o cronômetro já tiver vencido, a votação é encerrada).

## Boas práticas para 300+ pessoas

- **Internet do local**: Wi-Fi de evento costuma engasgar com 300 celulares. Avise que quem tiver 4G/5G pode usar os dados móveis.
- **Um voto por aparelho** por pergunta (identificação guardada no navegador). Abrir em aba anônima permite votar de novo; para um evento único isso costuma ser aceitável.
- Os celulares **não veem a parcial** durante a votação (evita influenciar quem ainda não votou); só o telão mostra.
- **Teste antes**: `node test/load.mjs` simula 300 participantes votando ao mesmo tempo e confere contagem, vencedor, empate, voto duplicado, cronômetro e reconexão.

## Identidade visual

Aplicada a partir do material "As Sete Esferas / YES MDV": paleta, esferas A–D, banner, logo, textura e faixa de
4 cores. Tudo fica em `public/theme.css` (variáveis no topo) e `public/img/` (banner, logo, textura).

**Fontes da marca:** os slides usam uma fonte display condensada e pesada (títulos, letras das esferas, números) e
uma monoespaçada (textos). Elas não vieram no material, então por enquanto o sistema usa alternativas
(`Impact`/`Arial Narrow` e `Roboto Mono`/`Courier New`). Para usar as originais, coloque os arquivos `.woff2` em
`public/fonts/` (`display.woff2`, `mono.woff2`, `mono-bold.woff2`, `mono-italic.woff2`) e descomente o bloco
`@font-face` no topo de `theme.css`.

## Créditos

O QR Code é gerado no navegador com o codificador "QRCode for JavaScript" de Kazuhiko Arase (licença MIT),
em `public/vendor/qrcode.js`. "QR Code" é marca registrada da DENSO WAVE INCORPORATED.
