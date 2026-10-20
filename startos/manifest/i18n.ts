export const short = {
  en_US: 'Solo merge mining for Dogecoin and Litecoin',
  es_ES: 'Minería en solitario fusionada para Dogecoin y Litecoin',
  de_DE: 'Solo-Merged-Mining für Dogecoin und Litecoin',
  pl_PL: 'Kopanie solo z łączeniem dla Dogecoina i Litecoina',
  fr_FR: 'Minage solo fusionné pour Dogecoin et Litecoin',
}

export const long = {
  en_US:
    'A stratum server and dashboard that mine Dogecoin and Litecoin at the same time, against your own nodes. ' +
    'Merge mining is not a trade-off: the stratum builds a Litecoin block whose coinbase commits to a Dogecoin block, ' +
    'and the single scrypt hash of that header is tested against both networks. One miner, the same electricity, ' +
    'two independent chances at a block. ' +
    'Point your scrypt miners here and the dashboard shows hashrate with history, your workers, how close each share is coming, ' +
    'and any blocks found on either chain. No pool, no fee, no third party: a block pays you directly from the coinbase. ' +
    'Requires the Litecoin Core and Dogecoin Core packages, both fully synced.',
  es_ES:
    'Un servidor stratum y un panel que minan Dogecoin y Litecoin a la vez, contra tus propios nodos. ' +
    'La minería fusionada no es un compromiso: el stratum construye un bloque de Litecoin cuyo coinbase se compromete con un bloque de Dogecoin, ' +
    'y el único hash scrypt de esa cabecera se compara con ambas redes. Un minero, la misma electricidad, dos oportunidades independientes. ' +
    'Sin pool, sin comisiones y sin terceros: un bloque te paga directamente desde el coinbase. ' +
    'Requiere los paquetes de Litecoin Core y Dogecoin Core, ambos completamente sincronizados.',
  de_DE:
    'Ein Stratum-Server und ein Dashboard, die Dogecoin und Litecoin gleichzeitig gegen deine eigenen Knoten minen. ' +
    'Merged Mining ist kein Kompromiss: das Stratum baut einen Litecoin-Block, dessen Coinbase sich auf einen Dogecoin-Block festlegt, ' +
    'und der eine Scrypt-Hash dieses Headers wird gegen beide Netzwerke geprüft. Ein Miner, derselbe Strom, zwei unabhängige Chancen. ' +
    'Kein Pool, keine Gebühr, keine Dritten: ein Block zahlt dich direkt aus der Coinbase. ' +
    'Erfordert die Pakete Litecoin Core und Dogecoin Core, beide vollständig synchronisiert.',
  pl_PL:
    'Serwer stratum i panel, które kopią Dogecoina i Litecoina jednocześnie, w oparciu o twoje własne węzły. ' +
    'Kopanie łączone nie jest kompromisem: stratum buduje blok Litecoina, którego coinbase wskazuje na blok Dogecoina, ' +
    'a pojedynczy skrót scrypt tego nagłówka jest sprawdzany względem obu sieci. Jedna koparka, ten sam prąd, dwie niezależne szanse. ' +
    'Bez poola, bez prowizji i bez osób trzecich: blok płaci ci bezpośrednio z coinbase. ' +
    'Wymaga pakietów Litecoin Core i Dogecoin Core, obu w pełni zsynchronizowanych.',
  fr_FR:
    'Un serveur stratum et un tableau de bord qui minent Dogecoin et Litecoin en même temps, sur vos propres nœuds. ' +
    'Le minage fusionné n’est pas un compromis : le stratum construit un bloc Litecoin dont le coinbase s’engage sur un bloc Dogecoin, ' +
    'et l’unique empreinte scrypt de cet en-tête est testée contre les deux réseaux. Un mineur, la même électricité, deux chances indépendantes. ' +
    'Pas de pool, pas de frais, pas de tiers : un bloc vous paie directement depuis le coinbase. ' +
    'Nécessite les paquets Litecoin Core et Dogecoin Core, tous deux entièrement synchronisés.',
}
