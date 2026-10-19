<p align="center"><img src="build/icon.png" width="96" alt="ClipNova"></p>

<h1 align="center">ClipNova</h1>

<p align="center">Editor de vídeo para <b>Windows</b> e <b>Linux</b>, com linha do tempo multifaixa, efeitos, transições e recursos de IA.<br>
<i>Video editor for Windows and Linux with a multi-track timeline, effects, transitions and AI features.</i></p>

<p align="center">🇧🇷 Português · 🇺🇸 English · 🇪🇸 Español · 🇷🇺 Русский</p>

---

## Download

A versão mais recente está em **[Releases](https://github.com/kromossomom-debug/ClipNova/releases/latest)**:

| Sistema | Arquivo |
|---|---|
| Windows (instalador) | `ClipNova-x.y.z-win-x64.exe` |
| Windows (portátil, sem instalar) | `ClipNova-x.y.z-portable.exe` |
| Linux (qualquer distro) | `ClipNova-x.y.z-linux-x86_64.AppImage` |
| Linux (Debian/Ubuntu) | `ClipNova-x.y.z-linux-amd64.deb` |

No Linux, use o AppImage: `chmod +x ClipNova-*.AppImage && ./ClipNova-*.AppImage`. Para o .deb: `sudo apt install ./ClipNova-*.deb`.

## Recursos

- **Linha do tempo multifaixa:**
  - faixa principal magnética, sobreposições, texto/stickers, efeitos e áudio;
  - arrastar, aparar, reordenar, ímã e zoom;
  - miniaturas na proporção correta e forma de onda.
- **Edição:**
  - dividir, duplicar, copiar/colar, congelar quadro, inverter clipe, espelhar, girar, recortar e extrair áudio;
  - desfazer/refazer ilimitado.
- **Vídeo e foto:**
  - escala, posição, rotação, opacidade, 12 modos de mistura e keyframes;
  - máscaras (linear, faixa, círculo, retângulo, coração, estrela) e chroma key com conta-gotas;
  - 16 filtros e ajustes de cor;
  - velocidade de 0.1x a 10x.
- **Animações:** entrada, saída e combo/loop.
- **Transições:** 13 tipos.
- **Efeitos:** 14 tipos (VHS, RGB, filme antigo, tremor…).
- **Texto:**
  - fonte, contorno, fundo, sombra e neon;
  - estilos rápidos e efeito máquina de escrever.
- **Stickers.**
- **Áudio:** música, narração pelo microfone, volume até 200% e fade in/out.
- **Exportação:** MP4 H.264/AAC de 480p a 4K, de 24 a 60 fps, renderizado quadro a quadro.
- **Tour guiado** na primeira vez que o editor é aberto (pode ser revisto pelo botão **?**).
- **4 idiomas:** português (BR), inglês, espanhol e russo. A escolha fica na tela inicial.

### IA (aba "IA")
Os recursos de IA usam a **sua própria chave gratuita do Google Gemini** ([obter chave](https://aistudio.google.com/apikey)). A chave fica criptografada no computador e só é enviada ao Google.

- **Legendas automáticas:** transcreve a fala e cria legendas sincronizadas. Dá para escolher idioma, palavras por legenda, estilo e posição.
- **Tradução de legendas** e **importação/exportação de .srt**.
- **Narração por IA (texto para fala)** com 10 vozes e vários tons.

### Ferramentas inteligentes (locais, sem internet)
- **Remover silêncios**
- **Dividir por cenas**
- **Melhorar voz:** redução de ruído e normalização de volume.

## Atalhos

| Atalho | Ação |
|---|---|
| Espaço | Reproduzir/pausar |
| Ctrl+B | Dividir |
| Delete | Excluir |
| Ctrl+D | Duplicar |
| Ctrl+C / Ctrl+V | Copiar / colar |
| Ctrl+Z / Ctrl+Y | Desfazer / refazer |
| ← → | Avança 1 quadro (Shift: 1s) |
| Ctrl+I | Importar |
| Ctrl+E | Exportar |
| + / − | Zoom |

## Desenvolvimento

Requisitos: Node.js 22 ou mais recente.

```bash
npm install
npm start            # roda o app
npm run dist:win     # Windows: instalador NSIS e versão portátil
npm run dist:linux   # Linux: AppImage e .deb (rode no Linux)
```

- Com npm 11, os scripts de instalação ficam bloqueados por padrão. Os pacotes `electron` e `ffmpeg-static` já estão liberados em `allowScripts` no `package.json`.
- O FFmpeg vem do pacote `ffmpeg-static`, que baixa o binário do sistema em que o `npm install` roda. Por isso o build de Linux deve ser feito no Linux.
- O GitHub Actions (`.github/workflows/release.yml`) gera os builds de Windows e Linux e publica um Release a cada tag `v*`.
- **Teste automatizado:** com `CLIPNOVA_TEST_SCRIPT=<arquivo.js>`, o script roda no renderer, com acesso a `window.__cn` e `native.testShot()`/`testQuit()`.

### Estrutura
```
src/main.js        processo principal: arquivos, FFmpeg, exportação, API do Gemini
src/js/render.js   compositor (prévia e exportação usam o mesmo código)
src/js/timeline.js linha do tempo
src/js/inspector.js painel de propriedades
src/js/ai.js       legendas, tradução, narração e ferramentas inteligentes
src/js/i18n*.js    idiomas
src/js/tour.js     tour guiado
```

## Licença

MIT. Projeto independente, sem afiliação com a ByteDance/CapCut nem com o Google.
