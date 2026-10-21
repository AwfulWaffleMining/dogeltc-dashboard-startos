import { IMPOSSIBLE, VersionInfo } from '@start9labs/start-sdk'

export const current = VersionInfo.of({
  version: '1.1.0:21',
  releaseNotes: {
    en_US:
      'The service will not start until you have answered the payout question. Saving two addresses, paying into the nodes’ own wallets, and declining to store anything all count as answers — but leaving it unanswered now blocks starting instead of starting a stratum that cannot pay.',
    es_ES:
      'El servicio no se iniciará hasta que hayas respondido a la pregunta de los pagos. Guardar dos direcciones, pagar a los monederos de los propios nodos y negarte a guardar nada cuentan como respuesta; dejarla sin responder ahora impide el arranque en lugar de iniciar un stratum que no puede pagar.',
    de_DE:
      'Der Dienst startet erst, wenn du die Auszahlungsfrage beantwortet hast. Zwei Adressen speichern, in die Wallets der Knoten zahlen oder das Speichern ablehnen gelten alle als Antwort — bleibt sie offen, wird der Start nun blockiert, statt ein Stratum zu starten, das nicht zahlen kann.',
    pl_PL:
      'Usługa nie uruchomi się, dopóki nie odpowiesz na pytanie o wypłaty. Zapisanie dwóch adresów, płacenie do portfeli samych węzłów oraz odmowa zapisywania czegokolwiek liczą się jako odpowiedź — brak odpowiedzi blokuje teraz uruchomienie, zamiast startować stratum, które nie ma komu zapłacić.',
    fr_FR:
      'Le service ne démarrera pas tant que vous n’aurez pas répondu à la question des paiements. Enregistrer deux adresses, payer dans les portefeuilles des nœuds et refuser de rien enregistrer comptent tous comme une réponse — la laisser sans réponse bloque désormais le démarrage au lieu de lancer un stratum incapable de payer.',
  },
  migrations: {
    up: async ({ effects }) => {},
    down: IMPOSSIBLE,
  },
})
