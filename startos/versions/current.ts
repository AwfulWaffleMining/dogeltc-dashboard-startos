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
  version: '0.1.0:2',
  releaseNotes: {
    en_US:
      'Requires each node to be sharing its RPC, which is off by default — the service now says so as a task instead of failing to start. Your worker name can be set yourself in Payouts. First release otherwise. Solo merge-mines Dogecoin and Litecoin against your own nodes — one scrypt hash tested against both targets, no pool and no fee. Both node packages must be installed and fully synced, and the service will not start until you have chosen where blocks pay.',
    es_ES:
      'Requiere que cada nodo comparta su RPC, que está desactivado por defecto: ahora el servicio lo indica como tarea en lugar de no arrancar. Puedes elegir tú mismo el nombre del trabajador en Pagos. Por lo demás, primera versión.',
    de_DE:
      'Setzt voraus, dass jeder Knoten sein RPC teilt, was standardmäßig aus ist — der Dienst sagt das jetzt als Aufgabe, statt nicht zu starten. Den Worker-Namen kannst du unter Auszahlungen selbst festlegen. Ansonsten die erste Veröffentlichung.',
    pl_PL:
      'Wymaga, by każdy węzeł udostępniał swoje RPC, co domyślnie jest wyłączone — usługa mówi o tym teraz jako o zadaniu, zamiast nie startować. Nazwę koparki możesz ustawić sam w Wypłatach. Poza tym pierwsze wydanie.',
    fr_FR:
      'Nécessite que chaque nœud partage son RPC, ce qui est désactivé par défaut — le service l’indique désormais sous forme de tâche au lieu de ne pas démarrer. Vous pouvez définir vous-même le nom du mineur dans Paiements. Première version par ailleurs.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
