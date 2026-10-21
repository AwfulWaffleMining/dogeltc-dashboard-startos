import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

/* 0.1.0:0 — first release of this package.
 *
 * The left side is the version of the thing being packaged, and here that is
 * this repository's own stratum (stratum/package.json is 0.1.0), because this
 * package has no upstream project but itself. The right side is the StartOS
 * package revision, which starts at 0.
 *
 * It was 1.1.0:20, copied verbatim from quai-dashboard-startos when this
 * package was scaffolded. That claimed a 1.1 line and twenty prior package
 * revisions, none of which ever existed. Nothing has been published, so this
 * is the last moment it can be corrected without rewriting a release history.
 *
 * 0.1.0 is also the honest signal: x86_64 only, and no block has ever been
 * found by this package on a real chain.
 */
export const current = VersionInfo.of({
  version: '0.1.0:0',
  releaseNotes: {
    en_US:
      'First release. Solo merge-mines Dogecoin and Litecoin against your own nodes — one scrypt hash tested against both targets, no pool and no fee. Both node packages must be installed and fully synced, and the service will not start until you have chosen where blocks pay.',
    es_ES:
      'Primera versión. Mina en solitario Dogecoin y Litecoin de forma combinada contra tus propios nodos: un único hash scrypt comprobado contra ambos objetivos, sin pool ni comisión. Ambos paquetes de nodo deben estar instalados y totalmente sincronizados, y el servicio no se iniciará hasta que elijas dónde se pagan los bloques.',
    de_DE:
      'Erste Veröffentlichung. Solo-Merge-Mining von Dogecoin und Litecoin gegen deine eigenen Knoten — ein Scrypt-Hash, gegen beide Ziele geprüft, ohne Pool und ohne Gebühr. Beide Knoten-Pakete müssen installiert und vollständig synchronisiert sein, und der Dienst startet erst, wenn du festgelegt hast, wohin Blöcke zahlen.',
    pl_PL:
      'Pierwsze wydanie. Samodzielne kopanie łączone Dogecoina i Litecoina na własnych węzłach — jeden skrót scrypt sprawdzany względem obu celów, bez poolu i bez prowizji. Oba pakiety węzłów muszą być zainstalowane i w pełni zsynchronizowane, a usługa nie uruchomi się, dopóki nie wybierzesz, gdzie trafiają bloki.',
    fr_FR:
      'Première version. Mine en solo Dogecoin et Litecoin en minage fusionné sur vos propres nœuds — un seul hachage scrypt testé contre les deux cibles, sans pool ni frais. Les deux paquets de nœud doivent être installés et entièrement synchronisés, et le service ne démarrera pas tant que vous n’aurez pas choisi où paient les blocs.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
