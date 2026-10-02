import {it,expect} from 'vitest'
import {controlPage,grantsPage} from '../src/control-pages.ts'
it('renders readable SSR plugin/status tables and human grant durations with escaped details',()=>{
  const html=controlPage('n123','<node>',{runtime:{version:'0.1.7-rc.2',persistence:'healthy',plugins:[{entryId:'entry',moduleName:'<script>',enabled:true}],jobs:[{createdAt:0,action:'plugin.install',status:'restart-required',target:'example@1.0.0'}]},supervisor:null})
  expect(html).toContain('<table>');expect(html).toContain('磁盘已安装，活动版本未确认，需受控重启');expect(html).toContain('1970-01-01');expect(html).not.toContain('<script>');expect(html).toContain('<details>');expect(html).toContain('task.cleanup')
  const grants=grantsPage([],[]);expect(grants).toContain('1 小时');expect(grants).toContain('30 天');expect(grants).not.toContain('name="expiresAt"')
})
