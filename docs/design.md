# Design e acessibilidade

## Direção

Ferramenta interna de operação em português do Brasil. Segue o design system **FlowPay** (Behance, "Fintech Saas Application"), cujas capturas de referência estão em `docs/design-reference/`: escuro primeiro, hierarquia forte, contraste suave, acento roxo e cores semânticas para estados. O produto é **somente escuro** (a referência não define tema claro); `color-scheme: dark` e `colorMode="dark"` no React Flow.

## Tokens (`src/app/globals.css`, `@theme`)

| Token | Valor | Uso |
|---|---|---|
| `bg` | `#0D0E17` | fundo da página |
| `surface` / `surface-2` | `#12131C` / `#181A26` | cards e barra lateral / campos, botões secundários |
| `line` | branco 8% | bordas |
| `fg` / `muted` | `#F4F4F8` / `#9395AB` | texto / texto secundário |
| `accent` / `accent-soft` | `#8A62FF` / `#A78BFA` | botão primário, item ativo / links e foco |
| `ok` | `#7CFFB2` | estado OK |
| `warn` | `#F59E0B` | Aviso |
| `alert` / `alert-fg` | `#EF4444` / `#F87171` | Alerta (preenchimento / texto, que precisa de mais contraste) |
| `nodata` | `#94A3B8` | Sem dados (a referência não tem cinza semântico) |
| `info` | `#60A5FA` | reservado (azul da referência) |

Tipografia: **Inter** (a referência usa Inter SemiBold). A prancha define H1 56 / H2 32 / corpo 22 / legenda 14 px para o quadro de apresentação; no produto, densidade de painel: títulos de página 24 px, corpo 14 px, legendas e cabeçalhos de tabela 11–12 px em caixa alta. Cantos arredondados: `rounded-2xl` em cards, `rounded-xl` em campos e botões.

## Componentes (`src/components/ui/`)

Barra lateral com marca e navegação (item ativo em roxo translúcido; no celular vira faixa horizontal), `Card`, `KpiCard` (ícone em chip, rótulo, valor grande), `PageHeader`, `SectionTitle`, botão primário com brilho roxo e secundário escuro, campos escuros com foco roxo, tabelas com cabeçalho em caixa alta e `StateBadge` (pílula com ponto + texto). Notificações/atividade seguem o cartão da referência (título, estados, link). Ícones são SVG de traço próprios, decorativos (`aria-hidden`).

## Telas

- **Mapa de jornadas (`/`):** KPIs (jornadas, em alerta, em aviso, saudáveis), grade de cartões — um por jornada, com a cor/estado dela, contagens e as aplicações como etiquetas coloridas —, grupo "Sem jornada", filtro "só jornadas com alerta ou aviso", atualização automática a cada 5 s com destaque piscante de 3 s no que mudou, "×N" nas aplicações que estão em N jornadas e destaque da mesma aplicação nas outras jornadas ao passar o cursor/foco. Card "Mudanças recentes" ao lado.
- **Alertas, detalhe, aplicação, novo alerta, máquina de estados:** cards, tabelas e formulário agrupado em seções ("Informações básicas", "Remediação automática", "Autorização"), como o formulário de referência.
- **Máquina de estados (`/graph`)** é o único uso de React Flow: nós arrastáveis (as posições arrastadas são preservadas), zoom, minimapa. Rótulos das arestas são posicionados por um algoritmo guloso que evita sobreposição (`placeLabels`); vale para as posições iniciais, e podem sobrepor se os nós forem arrastados.

## Acessibilidade

HTML semântico, navegação por teclado, foco visível (`outline` roxo), `aria-current` no menu, tabelas com `caption` e `scope`, regiões rotuladas nos grafos com **lista textual equivalente**, estado nunca só por cor (ponto + texto), respeito a `prefers-reduced-motion`. Contraste: texto secundário `#9395AB` sobre `#12131C` ≈ 5,6:1; vermelho de texto usa `#F87171`. Verificado visualmente em capturas do Chrome headless (1440 px) em 2026-10-23; **não medi contraste com ferramenta nem testei com leitor de tela ou em tela estreita**.

## Pendências de design

Tema claro (inexistente), revisão em celular, tela de edição de alertas (hoje só pela API), gráficos de tendência como na referência (não há série histórica ainda) e revisão com a skill `web-design-guidelines`.

## Manutenção

Mudanças visuais atualizam os tokens em `globals.css` e este guia.
