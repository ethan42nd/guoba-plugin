import jwt from 'jsonwebtoken'
import {Result} from '#guoba.framework'
import {ApiController, cfg, Constant} from '#guoba.platform'
import chalk from 'chalk'

const forcedOfflineAccounts = new Set()

export class UserController extends ApiController {
  constructor(guobaApp) {
    super('/user', guobaApp)
  }

  registerRouters() {
    this.get('/getLoginUser', this.getLoginUser)
    this.get('/list', this.getUserList)
    this.put('/account/status', this.setAccountStatus)
  }

  // 获取登录用户
  async getLoginUser(req) {
    const preferredUin = this.getPreferredUinFromReq(req)
    const current = await this.getCurrentAccount(preferredUin)
    return Result.ok({
      userId: current.userId,
      username: current.username,
      realName: current.realName,
      avatar: '',
      desc: '',
      homePath: '/home',
      roles: [
        {roleName: '超级管理员', value: 'sa'},
      ],
      sourceBotUin: current.userId,
      sourcePlatform: current.platform || '',
    })
  }

  // 获取账号列表
  async getUserList(req) {
    const preferredUin = this.getPreferredUinFromReq(req)
    const accounts = await this.resolveAccounts(preferredUin)
    return Result.ok(accounts)
  }

  // 设置账号上下线状态
  async setAccountStatus(req) {
    const {userId, action} = req.body || {}
    const uin = String(userId || '').trim()
    const nextAction = String(action || '').trim()
    logger.mark(
      `[Guoba] 账号状态切换请求: ${chalk.cyan(uin || '-')} -> ${nextAction === 'enable'
        ? chalk.green('enable')
        : nextAction === 'disable'
          ? chalk.red('disable')
          : chalk.yellow(nextAction || '-')}`,
    )
    if (!uin) {
      return Result.error('userId不能为空')
    }
    if (!['enable', 'disable'].includes(nextAction)) {
      return Result.error('action必须是 enable 或 disable')
    }

    const bot = this.getBotByUin(uin)
    if (!bot) {
      if (nextAction === 'disable') {
        forcedOfflineAccounts.add(uin)
        logger.mark(
          `[Guoba] 账号状态切换完成: ${chalk.cyan(uin)} -> ${chalk.red('disable')} ${chalk.gray('(already offline)')}`,
        )
        return Result.ok(true, '账号已离线')
      }
      return Result.error('账号不在线或暂不支持上线操作')
    }

    try {
      if (nextAction === 'enable') {
        if (typeof bot.login !== 'function') {
          if (typeof bot?.adapter?.connectWebSocket === 'function') {
            await bot.adapter.connectWebSocket()
            forcedOfflineAccounts.delete(uin)
            logger.mark(
              `[Guoba] 账号状态切换完成: ${chalk.cyan(uin)} -> ${chalk.green('enable')} ${chalk.gray('(reconnect)')}`,
            )
            return Result.ok(true, '已发送重连操作')
          }
          return Result.error('该账号暂不支持上线操作')
        }
        await bot.login()
        forcedOfflineAccounts.delete(uin)
        logger.mark(
          `[Guoba] 账号状态切换完成: ${chalk.cyan(uin)} -> ${chalk.green('enable')}`,
        )
        return Result.ok(true, '已发送上线操作')
      }

      if (typeof bot.logout === 'function') {
        await bot.logout()
        forcedOfflineAccounts.add(uin)
        logger.mark(
          `[Guoba] 账号状态切换完成: ${chalk.cyan(uin)} -> ${chalk.red('disable')}`,
        )
        return Result.ok(true, '已发送下线操作')
      }
      if (typeof bot.ws?.close === 'function') {
        bot.ws.close()
        forcedOfflineAccounts.add(uin)
        logger.mark(
          `[Guoba] 账号状态切换完成: ${chalk.cyan(uin)} -> ${chalk.red('disable')} ${chalk.gray('(ws.close)')}`,
        )
        return Result.ok(true, '已发送下线操作')
      }
      return Result.error('该账号暂不支持下线操作')
    } catch (error) {
      logger.error(
        `[Guoba] 账号状态切换失败: ${chalk.cyan(uin)} -> ${nextAction === 'enable'
          ? chalk.green('enable')
          : chalk.red('disable')}`,
        error,
      )
      return Result.error(`账号状态切换失败：${error?.message || error}`)
    }
  }

  async getCurrentAccount(preferredUin = '') {
    const uinList = this.getUinList()
    const preferredExists = preferredUin
      ? uinList.some(item => String(item) === String(preferredUin))
      : false
    const currentUin = preferredExists
      ? String(preferredUin)
      : this.getCurrentUin() || uinList[0]
    if (currentUin) {
      const bot = Bot?.bots?.[currentUin] || Bot?.[currentUin]
      return {
        userId: currentUin,
        username: currentUin,
        realName: this.getNickname(bot, currentUin),
        platform: this.getPlatformLabel(currentUin, bot?.adapter || {}),
      }
    }
    return {
      userId: '-',
      username: '-',
      realName: '-',
      platform: '',
    }
  }

  async resolveAccounts(preferredUin = '') {
    const uinList = this.getUinList()
    const preferredExists = preferredUin
      ? uinList.some(item => String(item) === String(preferredUin))
      : false
    const currentUin = preferredExists
      ? String(preferredUin)
      : this.getCurrentUin()

    const accounts = await Promise.all(
      uinList.map(async (uin, index) => this.resolveAccountItem(uin, index, currentUin))
    )

    return accounts
  }

  getPreferredUinFromReq(req) {
    const payload = this.getTokenPayload(req)
    const preferred = String(payload?.sourceBotUin || '').trim()
    return preferred
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

  async resolveAccountItem(uin, index, currentUin) {
    const bot = this.getBotByUin(uin)
    const adapter = bot?.adapter || {}
    const friendCount = await this.getFriendCount(bot)
    const groupCount = await this.getGroupCount(bot)
    const status = this.resolveBotStatus(uin, bot)
    const canEnable = status === 'offline' && (
      typeof bot?.login === 'function' || typeof bot?.adapter?.connectWebSocket === 'function'
    )
    const canDisable = status === 'online' && (
      typeof bot?.logout === 'function' || typeof bot?.ws?.close === 'function'
    )

    return {
      index: index + 1,
      userId: uin,
      username: uin,
      realName: this.getNickname(bot, uin),
      current: String(uin) === String(currentUin),
      adapterId: adapter?.id ? String(adapter.id) : '',
      adapterName: adapter?.name ? String(adapter.name) : '',
      platform: this.getPlatformLabel(uin, adapter),
      onlineDuration: this.getOnlineDuration(bot),
      friendCount,
      groupCount,
      homePath: '/home',
      status,
      canEnable,
      canDisable,
    }
  }

  getBotByUin(uin) {
    return Bot?.bots?.[uin] || Bot?.[uin]
  }

  resolveBotStatus(uin, bot) {
    if (forcedOfflineAccounts.has(String(uin || ''))) {
      return 'offline'
    }
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
    if (adapter?.name) {
      return String(adapter.name)
    }
    if (adapter?.id) {
      return String(adapter.id)
    }
    return '未知'
  }

  getOnlineDuration(bot) {
    const startTime = bot?.stat?.start_time
    if (!startTime) {
      return ''
    }
    const ms = startTime > 1e12 ? startTime : startTime * 1000
    if (typeof Bot?.getTimeDiff === 'function') {
      return Bot.getTimeDiff(ms)
    }
    return ''
  }

  async getFriendCount(bot) {
    if (!bot) {
      return 0
    }
    try {
      if (typeof bot.getFriendArray === 'function') {
        const arr = await bot.getFriendArray()
        if (Array.isArray(arr)) {
          return arr.length
        }
      }
    } catch {}
    if (bot.fl instanceof Map) {
      return bot.fl.size
    }
    return 0
  }

  async getGroupCount(bot) {
    if (!bot) {
      return 0
    }
    try {
      if (typeof bot.getGroupArray === 'function') {
        const arr = await bot.getGroupArray()
        if (Array.isArray(arr)) {
          return arr.length
        }
      }
    } catch {}
    if (bot.gl instanceof Map) {
      return bot.gl.size
    }
    return 0
  }
}
