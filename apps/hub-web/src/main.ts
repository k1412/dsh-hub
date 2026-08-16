/** DSH Hub Web entry: the unmodified official shell over Hub-routed APIs. */

import { AppWebEntry } from '@deepseek-ai/dsh-client-web'

const element = document.getElementById('root')
if (element === null) throw new Error('Hub Web: missing #root')
void new AppWebEntry(element).run()
