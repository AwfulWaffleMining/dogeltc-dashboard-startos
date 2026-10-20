import { setupManifest } from '@start9labs/start-sdk'
import { imageId } from '../utils'
import { long, short } from './i18n'

export const manifest = setupManifest({
  id: 'dogeltc-dashboard',
  title: 'Dogecoin + Litecoin Mining Dashboard',
  license: 'MIT',
  packageRepo: 'https://github.com/AwfulWaffleMining/dogeltc-dashboard-startos',
  upstreamRepo:
    'https://github.com/AwfulWaffleMining/dogeltc-dashboard-startos',
  marketingUrl: 'https://www.awfulwafflemining.com',
  donationUrl:
    'https://github.com/AwfulWaffleMining/dogeltc-dashboard-startos/blob/main/DONATE.md',
  description: { short, long },
  volumes: ['main'],
  images: {
    [imageId]: {
      source: { dockerBuild: {} },
      /* x86_64 only for now. The image carries a Go binary and a Node
       * runtime, neither of which has been built or run on another
       * architecture here. Both node packages ship aarch64, so widening this
       * is worth doing — but only after it is built and exercised, not by
       * adding a string to this list. */
      arch: ['x86_64'],
    },
  },
  dependencies: {
    /* Both nodes are required, and both must be SYNCED — see
     * startos/dependencies.ts for why AuxPoW makes this asymmetric but still
     * mandatory on both sides. */
    litecoin: {
      description:
        'Litecoin is the parent chain: work is built against this node, and without it there is no block to mine. Must be fully synced.',
      optional: false,
      metadata: {
        title: 'Litecoin Core',
        icon: 'https://raw.githubusercontent.com/AwfulWaffleMining/litecoin-startos/main/icon.svg',
      },
    },
    dogecoin: {
      description:
        'Dogecoin is the merge-mined chain: its block is committed into the Litecoin block being mined, so the same work earns a chance at both. Must be fully synced.',
      optional: false,
      metadata: {
        title: 'Dogecoin Core',
        icon: 'https://raw.githubusercontent.com/AwfulWaffleMining/dogecoin-startos/main/icon.svg',
      },
    },
  },
})
