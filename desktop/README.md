# Agy Remote

App Android para controlar o Antigravity (CLI `agy`) do seu PC pelo celular, com conversas e memória compartilhadas entre os dois.

## Como funciona

```
Celular (app Android)    ──Wi-Fi/Tailscale──>  PC: server.js (porta 8790)  ──>  agy -p ... --conversation <id>
```

- **Conversas**: ficam no PC (`store.json` na pasta de dados: `%APPDATA%\Agy Remote\data` no app desktop, `server/data` no servidor solto) e o app guarda uma cópia para ler offline. O agy guarda o contexto de cada conversa pelo ID, então dá para começar no PC e continuar no celular (e vice-versa).
- **Sessões do agy no PC**: aparecem no menu e podem ser retomadas pelo celular.
- **Continuar no PC**: o botão 🖥️ abre a conversa num terminal do PC (`agy --conversation <id>`).
- **Memória**: fica numa seção própria do `~/.gemini/GEMINI.md`, que o agy lê em toda sessão (PC e celular). O resto do arquivo não é mexido; um backup é criado na primeira gravação (`GEMINI.md.bak-agyremote`).
- **Permissões**: o padrão é "Editar arquivos". O que fica bloqueado depende de cada CLI e **não é garantido** (no Windows o Codex roda sem sandbox; veja [Segurança](../README.md#segurança--security)). Quando a CLI informa um bloqueio, o app mostra o botão "Repetir liberando tudo". "Liberar tudo" desliga os pedidos de permissão (ex.: `--dangerously-skip-permissions`).

## Uso

1. No PC: rode `node server/server.js`, ou o app desktop com `npm install` e `npm start` dentro de `desktop/` (`npm run dist` gera o instalador). O ícone do instalador é opcional: coloque um `desktop/build/icon.png`.
2. Para usar o celular, ligue o acesso pela rede (desligado por padrão): `"lan": true` no `config.json` da pasta de dados, ou `AGY_REMOTE_LAN=1`, e reinicie. Permita o programa no firewall do Windows (só rede privada).
3. No celular: instale o app Android. O APK não vem no repositório; compile como abaixo.
4. Abra o app, digite o endereço do PC (ex.: `192.168.0.10:8790`) e depois o código de 6 dígitos (no app desktop: Ajustes ou menu da bandeja; no servidor solto: no terminal).
5. No PC, a mesma interface fica em http://localhost:8790.

Fora de casa: instale o Tailscale no PC e no celular (mesma conta) e use o IP `100.x.x.x` do PC. Não abra a porta 8790 no roteador.

## Recompilar o APK

O Gradle do Android não aceita acento no caminho ("Área de Trabalho"), então compile uma cópia:

```bash
cp -r android/. $HOME/agy-remote-build/
cd $HOME/agy-remote-build && gradle assembleRelease
```

O arquivo sai em `app/build/outputs/apk/release/`, assinado com a chave de debug (uso pessoal). Para o servidor solto oferecer o download em `/AgyRemote.apk`, copie-o com o nome `AgyRemote.apk` para a raiz do repositório ou aponte `AGY_REMOTE_APK` para ele.

A interface fica no servidor (`server/public/index.html`); mudanças nela não precisam de APK novo.
