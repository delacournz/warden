import { basename } from "node:path";

export const COMPLETION_SHELLS = ["zsh", "bash", "fish"] as const;
export type CompletionShell = (typeof COMPLETION_SHELLS)[number];

const isShell = (name: string): name is CompletionShell => (COMPLETION_SHELLS as readonly string[]).includes(name);

/** The user's login shell (`$SHELL`), when warden ships completion for it. */
export function shellFromEnv(env: Record<string, string | undefined>): CompletionShell | undefined {
	const name = env.SHELL ? basename(env.SHELL) : "";
	return isShell(name) ? name : undefined;
}

/**
 * zsh: `_describe` groups commands / options / values with their descriptions. With zsh's default
 * AUTO_MENU, tab once lists, tab again picks the first, further tabs cycle; `menu select` (only when the
 * user has no `menu` style of their own) highlights the pick in the list.
 */
const ZSH = `#compdef warden
# warden shell completion (zsh). Load after compinit: source <(warden completion zsh)
_warden() {
  local -a lines subcmds opts vals
  local line kind rest value desc files=0 ret=1
  lines=("\${(@f)$("\${words[1]}" __complete -- "\${(@)words[2,CURRENT-1]}" "$PREFIX" 2>/dev/null)}")
  for line in "\${lines[@]}"; do
    kind=\${line%%$'\\t'*}
    rest=\${line#*$'\\t'}
    value=\${rest%%$'\\t'*}
    desc=\${rest#*$'\\t'}
    case $kind in
      files) files=1 ;;
      command) subcmds+=("\${value//:/\\\\:}:$desc") ;;
      option) opts+=("\${value//:/\\\\:}:$desc") ;;
      value) vals+=("\${value//:/\\\\:}") ;;
    esac
  done
  (( $#subcmds )) && _describe -t commands 'warden command' subcmds && ret=0
  (( $#opts )) && _describe -t options 'option' opts && ret=0
  (( $#vals )) && _describe -t values 'value' vals && ret=0
  (( files )) && _files && ret=0
  return ret
}
() {
  local style
  zstyle -s ':completion:*:*:warden:*' menu style || zstyle ':completion:*:*:warden:*' menu select
}
if (( ! $+functions[compdef] )); then autoload -Uz compinit && compinit; fi
compdef _warden warden
`;

/**
 * bash has no per-command menu: tab-to-cycle is readline's global
 * \`bind 'TAB:menu-complete'\` + \`bind 'set show-all-if-ambiguous on'\` + \`bind 'set menu-complete-display-prefix on'\`,
 * which warden leaves to the user (the docs show it).
 */
const BASH = `# warden shell completion (bash). Load with: source <(warden completion bash)
_warden() {
  local cur=\${COMP_WORDS[COMP_CWORD]} kind value desc files=0 f
  COMPREPLY=()
  while IFS=$'\\t' read -r kind value desc; do
    case $kind in
      files) files=1 ;;
      command|option|value) COMPREPLY+=("$value") ;;
    esac
  done < <("\${COMP_WORDS[0]}" __complete -- "\${COMP_WORDS[@]:1:COMP_CWORD-1}" "$cur" 2>/dev/null)
  if (( files )); then
    while IFS= read -r f; do COMPREPLY+=("$f"); done < <(compgen -f -- "$cur")
  fi
}
complete -F _warden warden
`;

/** fish's pager already lists on the first tab and cycles on the next ones. */
const FISH = `# warden shell completion (fish). Load with: warden completion fish | source
function __warden_complete
    set -l tokens (commandline -opc)
    set -l bin $tokens[1]
    set -e tokens[1]
    set -l current (commandline -ct)
    for line in ($bin __complete -- $tokens $current 2>/dev/null)
        set -l parts (string split \\t -- $line)
        switch $parts[1]
            case files
                __fish_complete_path $current
            case '*'
                printf '%s\\t%s\\n' $parts[2] $parts[3]
        end
    end
end
complete -c warden -f -a '(__warden_complete)'
`;

const SCRIPTS: Record<CompletionShell, string> = { zsh: ZSH, bash: BASH, fish: FISH };

export function completionScript(shell: CompletionShell): string {
	return SCRIPTS[shell];
}
