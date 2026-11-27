# Agy Remote

App Android para controlar o Antigravity (CLI `agy`) do seu PC pelo celular, com conversas e memória compartilhadas entre os dois.

## Como funciona

```
Celular (AgyRemote.apk)  ──Wi-Fi/Tailscale──>  PC: server.js (porta 8790)  ──>  agy -p ... --conversation <id>
```

- **Conversas**: ficam no PC (`server/data/store.json`) e o app guarda uma cópia para ler offline. O agy guarda o contexto de cada conversa pelo ID, então dá para começar no PC e continuar no celular (e vice-versa).
- **Sessões do agy no PC**: aparecem no menu e podem ser retomadas pelo celular.
- **Continuar no PC**: o botão 🖥️ abre a conversa num terminal do PC (`agy --conversation <id>`).
- **Memória**: fica numa seção própria do `~/.gemini/GEMINI.md`, que o agy lê em toda sessão (PC e celular). O resto do arquivo não é mexido; um backup é criado na primeira gravação (`GEMINI.md.bak-agyremote`).
- **Permissões**: "Editar arquivos" (padrão) bloqueia comandos de terminal; quando isso acontece, o app mostra o botão "Repetir liberando tudo". "Liberar tudo" usa `--dangerously-skip-permissions`.

## Uso

1. No PC: dê dois cliques em **Iniciar Agy Remote.cmd**. Na primeira vez, permita o Node.js no firewall do Windows (rede privada).
2. No celular: instale o **AgyRemote.apk** (permita "instalar apps desconhecidos").
3. Abra o app, digite o endereço "No celular" que aparece na janela (ex.: `192.168.0.10:8790`) e depois o código de 6 dígitos.
4. No PC, a mesma interface fica em http://localhost:8790.

Fora de casa: instale o Tailscale no PC e no celular (mesma conta) e use o IP `100.x.x.x` do PC. Não abra a porta 8790 no roteador.

## Recompilar o APK

O Gradle do Android não aceita acento no caminho ("Área de Trabalho"), então compile uma cópia:

```bash
cp -r android/. $HOME/agy-remote-build/
cd $HOME/agy-remote-build && gradle assembleRelease
```

A interface fica no servidor (`server/public/index.html`); mudanças nela não precisam de APK novo.
