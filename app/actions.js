const Client = require('instagram-private-api').V1
const bot = require('../telegram')

const Account = require('./controllers/account')
const Source = require('./controllers/source')
const Task = require('./controllers/task')

function random (min, max) {
  let rand = min - 0.5 + Math.random() * (max - min + 1)
  rand = Math.round(rand)
  return rand
}

// Execution postponing
function sleep (time) {
  return new Promise(resolve => {
    setTimeout(() => {
      resolve()
    }, time)
  })
}

// Authorization
exports.auth = (login, password) => {
  const device = new Client.Device(login)
  const storage = new Client.CookieFileStorage(`./cookies/${login}.txt`)

  return Client.Session.create(device, storage, login, password)
}

// Задание подписаться + лайк
exports.followLike = async task => {
  try {
    let account = await Account.contains(task.user, task.login)
    let session = await this.auth(account.login, account.password)

    switch (task.params.sourceType) {
      case 'Источники':
        return await this.followLikeSource(task, session, account)

      case 'Пользователь':
        return await this.followLikeUser(task, session, account)

      default:
        throw new Error(
          'Нет подходящего обработчика для: ' + task.params.sourceType
        )
        break
    }
  } catch (err) {
    return err
  }
}

// подписка+лайк из источника пользователь
exports.followLikeUser = async (task, session, account) => {
  try {
    const source = await Source.contains(task.params.source)
    if (!source) throw new Error('Источник не существует')

    // По истечению срока сбрасываем кэш
    if (+source.date + 10368000 < Date.now()) {
      await Source.remove({ name: task.params.source })
      throw new Error('Срок годности базы истек')
    }
  } catch (e) {
    // Загружаем источник
    const source = await this.getAccountFollowers(session, task.params.source)
    await Source.create({ name: task.params.source, source: source })

    // Если количество подписчиков меньше указанного в задании, обновляем количество
    if (source.length < task.params.actionFollow) {
      await Task.changeCount(task._id, source.length)
    }
  }

  // Запускаем задачу
  await this.followLikeSource(task, session, account)
}

// подписка+лайк из источника
exports.followLikeSource = async (task, session, account) => {
  try {
    const id = task._id.toString()

    // Поиск источника
    const source = await Source.contains(task.params.source)

    // Список подписок
    const following = task.params.following

    // Кол. подписок в час
    const action = Math.round(task.params.actionFollowDay / 24)

    // Массив пользователей для обхода
    const users = []

    // Поиск уникальных пользователей, для подписки
    const findUsers = async (limit = false) => {
      for (let user of source.source) {
        if (following.includes(user)) continue

        // Ранее подписывались, если да, то пропускам
        let used = true
        try {
          const status = await Account.checkFollowing(
            account.user,
            account.login,
            user
          )
          if (!status) throw new Error('empty')
        } catch (e) {
          used = false
        }

        if (used) continue
        if (limit && users.length === limit) break

        // Добавляем в массив пользователей
        users.push(user)

        // Добавляем пользователя в временную базу подписок
        following.push(user)

        // Если нет лимита, то выборка 1 пользователя
        if (!limit) break
      }
    }

    await findUsers(action)

    // Если больше пользователей нет из задачи, то завершаем задание
    // Или перевыполнили план
    if (!users.length || following.length >= task.params.actionFollow) {
      console.log(
        'Задача остановлена',
        users,
        following,
        task.params.actionFollow
      )
      Task.finish(id)
      return true
    }

    // Обход пользователй и подписка
    for (let user of users) {
      try {
        // Поиск пользователя
        const searchUser = await Client.Account.searchForUser(session, user)

        const time = Math.round(3000 / action * random(50, 1000))
        await sleep(time)

        let relationship = await this.getFollow(session, searchUser)
        if (
          relationship._params.following ||
          relationship._params.outgoingRequest ||
          searchUser.params.friendshipStatus.is_private
        ) {
          // Фиксирум подписку
          Task.addUserFollow(id, user)
          Account.following(task.user, task.login, user)

          // Ставим лайк
          await this.getLike(
            session,
            task.user,
            task.login,
            searchUser,
            task.params.actionLikeDay
          )
        }
      } catch (err) {
        // Сработал лимит, останавливаем задачу
        if (err.name === 'RequestsLimitError') {
          bot.sendMessage(
            task.user,
            '⛔️ Instagram предупредил о превышении лимита, пожалуйста уменьшите количество действий в день'
          )
          break
        }

        if (err.name === 'IGAccountNotFoundError') {
          // Удаляем пользователя из базы
          Source.removeUserSource(source.name, user)
          console.log(`Удалили пользователя ${user}`)

          // Пользователь не найден, необходимо вместо него,
          // подставить другого
          await findUsers()
        }
      }
    }

    return false
  } catch (err) {
    console.log(err)
  }
}

// Подписка
exports.getFollow = async (session, account) => {
  return Client.Relationship.create(session, account._params.id.toString())
}

// Достаем контент для лайка
exports.getLike = async (session, user, login, account, limit = 1) => {
  try {
    let feed = await new Client.Feed.UserMedia(
      session,
      account._params.id,
      limit
    )
    let media = await feed.get()

    let i = 0
    for (let item of media) {
      if (limit == i) break

      let used = true
      try {
        const checkLink = await Account.checkLike(user, login, item._params.id)
        if (!checkLink) throw new Error('База отсутствует')
      } catch (e) {
        used = false
      }

      // Пропускаем ранее лайкнутые
      if (used) continue

      // Установка лайка
      await new Client.Like.create(session, item._params.id)

      // Записываем информацию о лайке
      Account.like(user, login, item._params.id)

      i++
    }
  } catch (err) {
    return err
  }
}

// Задание отписаться
exports.unFollow = async task => {
  try {
    let id = task._id.toString()

    // Поиск данных аккаунта
    let account = await Account.contains(task.user, task.login)

    // Авторизация
    let session = await this.auth(account.login, account.password)

    // Список пользователей, от которых надо отписаться
    let following = task.params.following

    // Список от которых уже отписались
    let unFollowing = task.params.unFollowing

    if (!following.length) {
      // Загружаем список подписок
      following = await this.followLoad(
        session,
        account.login,
        account.password
      )

      // попробывать реализовать повторный запрос подписок,
      // чтобы получить наибоелее полный список подписок

      // Сохраняем для переиспользования
      Task.followingUpdate(id, following)
    }

    // Кол. отписок в час
    let action = Math.round(task.params.actionFollowingDay / 24)

    // Храним пользователей для отписки
    let users = []

    // Поиск уникальных пользователей, для отписки
    let findUsers = (limit = false) => {
      for (let user of following) {
        if (unFollowing.includes(user)) continue
        if (limit && users.length === limit) break

        // Добавляем в массив пользователей
        users.push(user)

        // Добавляем пользователя в временную базу отподписок, тем самым пропуская удаленные аккаунты
        unFollowing.push(user)

        if (!limit) break
      }
    }

    findUsers(action)

    // Если больше нет подписчиков, завершаем задачу
    if (!users.length) {
      await Task.finish(id)
      return true
    }

    // Обход пользователй и отписка
    for (let user of users) {
      try {
        // Поиск пользователя
        let searchUser = await Client.Account.searchForUser(session, user)

        let time = Math.round(3000 / action * random(50, 1000))
        await sleep(time)

        let relationship = await this.getUnFollow(session, searchUser)
        if (!relationship._params.following) {
          // Фиксируем пользователя
          Task.unFollowAddUser(id, user)

          // Добавляем в базу подписок пользователей из отписок
          // чтобы в будущем повторно на них не подписаться
          Account.following(task.user, task.login, user)
        }
      } catch (err) {
        // Удаляем не существующий аккаунт из списка отписок
        if (err.name === 'IGAccountNotFoundError') {
          Task.removeUnFollowUser(id, user)
        }

        // Ищем замену
        findUsers()
      }
    }

    return false
  } catch (err) {
    return err
  }
}

// Отписка
exports.getUnFollow = async (session, user) => {
  return Client.Relationship.destroy(session, user._params.id.toString())
}

// Получить подписчиков аккаунта
exports.followLoad = async (session, login) => {
  try {
    const account = await Client.Account.searchForUser(session, login)
    const feed = await new Client.Feed.AccountFollowing(
      session,
      account._params.id
    )

    // Сохраняем подписчиков
    let allFollowing = await feed.all()

    let following = []
    for (let item of allFollowing) {
      following.push(item._params.username)
    }
    return following
  } catch (err) {
    return `Ошибка при загрузки подписчиков для пользователя ${login}: ${err}`
  }
}

// Загрузка списка подписчиков группы
exports.getAccountFollowers = async (session, login) => {
  try {
    const account = await Client.Account.searchForUser(session, login)
    const feeds = await new Client.Feed.AccountFollowers(
      session,
      account._params.id
    )
    const data = await feeds.all()
    const users = data.map(item => item._params.username)

    return users
  } catch (e) {
    console.log(e)
    return []
  }
}

// Поиск пользователя
exports.searchUser = async (session, user) =>
  await Client.Account.searchForUser(session, user)