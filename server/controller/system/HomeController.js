import os from 'os'
import fs from 'fs'
import path from 'path'
import jwt from 'jsonwebtoken'
import lodash from 'lodash'
import {_paths, _version, ApiController, cfg, Constant} from '#guoba.platform'
import {autowired, Result} from '#guoba.framework'
import {isTRSS, isV2, isV3, isV4, yunzaiVersion} from '#guoba.adapter'

/**
 * 首页相关查询
 */
export class HomeController extends ApiController {

  botService = autowired('botService')
  oicqService = autowired('oicqService')

  constructor(guobaApp) {
    super('/home', guobaApp)
  }

  registerRouters() {
    this.get('/data', this.getHomeData)
    this.get('/dashboard', this.getDashboardData)
    this.get('/random-image', this.randomImage)
  }

  /** 获取首页数据 */
  async getHomeData() {
    return Result.ok({
      cookieCount: await this.botService.getCookieCount(),
      friendCount: await this.oicqService.getFriendCount(),
      groupCount: await this.oicqService.getGroupCount(),
    })
  }

  /** 获取新版仪表盘数据 */
  async getDashboardData(req) {
    const [cookieCountRaw, friendCountRaw, groupCountRaw] = await Promise.all([
      this.botService.getCookieCount(),
      this.oicqService.getFriendCount(),
      this.oicqService.getGroupCount(),
    ])
    const cookieCount = Number(cookieCountRaw) || 0
    const friendCount = Number(friendCountRaw) || 0
    const groupCount = Number(groupCountRaw) || 0

    const uinList = this.getUinList()
    const preferredUin = this.getPreferredUinFromReq(req)
    const currentUin = this.resolveCurrentUin(preferredUin, uinList)

    const accountRows = uinList.map((uin) => {
      const bot = this.getBotByUin(uin)
      const online = this.resolveBotStatus(bot) === 'online'
      const adapter = bot?.adapter || {}
      return {
        nickname: this.getNickname(bot, uin),
        online,
        platform: this.getPlatformLabel(uin, adapter),
        uin,
      }
    })

    const onlineCount = accountRows.filter((item) => item.online).length
    const offlineCount = Math.max(0, accountRows.length - onlineCount)
    const platformMap = {}
    for (const item of accountRows) {
      const key = item.platform || '未知'
      platformMap[key] = (platformMap[key] || 0) + 1
    }
    const platformDistribution = Object.entries(platformMap)
      .map(([name, count]) => ({name, count}))
      .sort((a, b) => b.count - a.count)

    const currentBot = currentUin ? this.getBotByUin(currentUin) : null

    const processUptimeSec = Math.max(0, Math.floor(process.uptime()))
    const systemUptimeSec = Math.max(0, Math.floor(os.uptime()))

    const processMemory = process.memoryUsage()
    const systemMemoryTotal = os.totalmem()
    const systemMemoryFree = os.freemem()
    const systemMemoryUsed = Math.max(0, systemMemoryTotal - systemMemoryFree)
    const heapUsagePercent = processMemory.heapTotal > 0
      ? Number(((processMemory.heapUsed / processMemory.heapTotal) * 100).toFixed(2))
      : 0
    const systemMemoryUsagePercent = systemMemoryTotal > 0
      ? Number(((systemMemoryUsed / systemMemoryTotal) * 100).toFixed(2))
      : 0

    const cpus = os.cpus() || []
    const loadavg = os.loadavg()

    let redisAvailable = false
    let redisKeyCount = 0
    try {
      await redis.ping()
      redisAvailable = true
      if (typeof redis.dbsize === 'function') {
        redisKeyCount = Number(await redis.dbsize()) || 0
      } else if (typeof redis.dbSize === 'function') {
        redisKeyCount = Number(await redis.dbSize()) || 0
      }
    } catch {}

    return Result.ok({
      accounts: {
        currentNickname: this.getNickname(currentBot, currentUin),
        currentPlatform: this.getPlatformLabel(currentUin, currentBot?.adapter || {}),
        currentUin: currentUin || '',
        list: accountRows,
        offlineCount,
        onlineCount,
        total: accountRows.length,
      },
      business: {
        cookieCount,
        friendCount,
        groupCount,
      },
      env: {
        botMode: isTRSS ? 'TRSS' : 'Yunzai',
        guobaVersion: _version,
        nodeVersion: process.version,
        runtime: isV4 ? 'v4' : isV3 ? 'v3' : isV2 ? 'v2' : 'unknown',
        yunzaiVersion: yunzaiVersion || '',
      },
      platformDistribution,
      redis: {
        available: redisAvailable,
        keyCount: redisKeyCount,
      },
      runtime: {
        cpu: {
          cores: cpus.length,
          model: cpus[0]?.model || '',
        },
        loadavg: {
          fifteen: Number((loadavg[2] || 0).toFixed(2)),
          five: Number((loadavg[1] || 0).toFixed(2)),
          one: Number((loadavg[0] || 0).toFixed(2)),
        },
        processMemory: {
          external: processMemory.external,
          externalText: this.formatBytes(processMemory.external),
          heapTotal: processMemory.heapTotal,
          heapTotalText: this.formatBytes(processMemory.heapTotal),
          heapUsagePercent,
          heapUsed: processMemory.heapUsed,
          heapUsedText: this.formatBytes(processMemory.heapUsed),
          rss: processMemory.rss,
          rssText: this.formatBytes(processMemory.rss),
        },
        processUptime: {
          seconds: processUptimeSec,
          text: this.formatDuration(processUptimeSec),
        },
        systemMemory: {
          free: systemMemoryFree,
          freeText: this.formatBytes(systemMemoryFree),
          total: systemMemoryTotal,
          totalText: this.formatBytes(systemMemoryTotal),
          usagePercent: systemMemoryUsagePercent,
          used: systemMemoryUsed,
          usedText: this.formatBytes(systemMemoryUsed),
        },
        systemUptime: {
          seconds: systemUptimeSec,
          text: this.formatDuration(systemUptimeSec),
        },
      },
    })
  }

  // 随机角色图片
  randomImage(req, res) {
    let imgPath = this.getRandomRoleImage()
    if (imgPath != null) {
      res.sendFile(imgPath)
    } else {
      res.sendFile(path.join(_paths.pluginResources, 'images/no-miao.png'))
    }
    return Result.VOID
  }

  // 安装了喵喵插件后，获取随机角色图片
  getRandomRoleImage() {
    if (!this.dirPaths) {
      let miaoPath = path.join(_paths.root, 'plugins', 'miao-plugin')
      this.dirPaths = [
        path.join(miaoPath, 'resources/character-img'),
        path.join(miaoPath, 'resources/miao-res-plus/character-img'),
      ]
      this.dirPaths = this.dirPaths.filter(p => fs.existsSync(p))
    }
    if (this.dirPaths.length === 0) {
      return null
    }
    let dirPath = lodash.sample(this.dirPaths)
    let rolePaths = []
    fs.readdirSync(dirPath).forEach(p => rolePaths.push(path.join(dirPath, p)))
    if (rolePaths.length === 0) {
      return null
    }
    let rolePath = null
    let picPaths = []
    for (let i = 0; i < 10; i++) {
      rolePath = lodash.sample(rolePaths)
      if (fs.statSync(rolePath).isDirectory()) {
        picPaths = []
        fs.readdirSync(rolePath).filter((p) => /\.(jpg|png|jpeg|webp)$/i.test(p)).forEach(p => picPaths.push(path.join(rolePath, p)))
        // 好可怜，居然一张图片都没有，最多尝试10次
        if (picPaths.length > 0) {
          break
        }
      } else {
        rolePath = null
      }
    }
    if (picPaths.length === 0) {
      return null
    }
    return lodash.sample(picPaths)
  }

  getTokenPayload(req) {
    try {
      const tokenHeader = req?.headers?.[Constant.TOKEN_KEY]
      const tokenFromHeader = Array.isArray(tokenHeader) ? tokenHeader[0] : tokenHeader
      const token = String(tokenFromHeader || req?.query?.token || '').trim()
      if (!token) {
        return {}
      }
      try {
        return jwt.verify(token, cfg.getJwtSecret()) || {}
      } catch {
        return jwt.decode(token) || {}
      }
    } catch {
      return {}
    }
  }

  getPreferredUinFromReq(req) {
    const payload = this.getTokenPayload(req)
    return String(payload?.sourceBotUin || '').trim()
  }

  resolveCurrentUin(preferredUin, uinList) {
    const preferredExists = preferredUin
      ? uinList.some(item => String(item) === String(preferredUin))
      : false
    if (preferredExists) {
      return String(preferredUin)
    }
    const byUinValue = this.getCurrentUin()
    return byUinValue || uinList[0] || ''
  }

  getCurrentUin() {
    try {
      if (typeof Bot?.uin?.toJSON === 'function') {
        return String(Bot.uin.toJSON() || '')
      }
      return String(Bot?.uin || '')
    } catch {
      return ''
    }
  }

  getUinList() {
    const raw = Array.isArray(Bot?.uin)
      ? [...Bot.uin]
      : (Bot?.uin ? [Bot.uin] : [])
    return raw
      .map(item => String(item || '').trim())
      .filter(Boolean)
  }

  getBotByUin(uin) {
    return Bot?.bots?.[uin] || Bot?.[uin]
  }

  resolveBotStatus(bot) {
    if (!bot) {
      return 'offline'
    }

    const wsReadyState = bot?.ws?.readyState
    if (typeof wsReadyState === 'number') {
      return wsReadyState === 1 ? 'online' : 'offline'
    }

    if (typeof bot?.isOnline === 'function') {
      try {
        return bot.isOnline() ? 'online' : 'offline'
      } catch {}
    }
    if (typeof bot?.isOnline === 'boolean') {
      return bot.isOnline ? 'online' : 'offline'
    }

    return 'online'
  }

  getNickname(bot, fallbackUin) {
    const name = bot?.nickname || bot?.info?.nickname || bot?.name
    if (name) {
      return String(name)
    }
    return String(fallbackUin || '')
  }

  getPlatformLabel(uin, adapter) {
    const adapterId = String(adapter?.id || '').toLowerCase()
    if (String(uin).startsWith('dc_') || adapterId === 'discord') {
      return 'Discord'
    }
    if (String(uin).startsWith('stdin')) {
      return '控制台'
    }
    if (adapter?.name) {
      return String(adapter.name)
    }
    if (adapter?.id) {
      return String(adapter.id)
    }
    return '未知'
  }

  formatDuration(totalSeconds) {
    const sec = Math.max(0, Number(totalSeconds) || 0)
    const day = Math.floor(sec / 86400)
    const hour = Math.floor((sec % 86400) / 3600)
    const minute = Math.floor((sec % 3600) / 60)
    const second = Math.floor(sec % 60)
    if (day > 0) {
      return `${day}天 ${hour}时 ${minute}分`
    }
    if (hour > 0) {
      return `${hour}时 ${minute}分`
    }
    if (minute > 0) {
      return `${minute}分 ${second}秒`
    }
    return `${second}秒`
  }

  formatBytes(bytes) {
    const value = Number(bytes) || 0
    if (value < 1024) {
      return `${value} B`
    }
    const units = ['KB', 'MB', 'GB', 'TB']
    let size = value / 1024
    let unitIdx = 0
    while (size >= 1024 && unitIdx < units.length - 1) {
      size /= 1024
      unitIdx += 1
    }
    return `${size.toFixed(size >= 100 ? 0 : 1)} ${units[unitIdx]}`
  }

}
