import type { LinkSchema } from '@@/schemas/link'
import type { z } from 'zod'
import { parsePath, withQuery } from 'ufo'

export default eventHandler(async (event) => {
  const { pathname: slug } = parsePath(event.path.replace(/^\/|\/$/g, '')) // remove leading and trailing slashes
  const { slugRegex, reserveSlug } = useAppConfig(event)
  const { homeURL, linkCacheTtl, redirectWithQuery, caseSensitive } = useRuntimeConfig(event)
  const { cloudflare } = event.context

  if (event.path === '/' && homeURL)
    return sendRedirect(event, homeURL)

  if (slug?.startsWith('b:')) {
    const encoded = slug.slice(2)
    if (!encoded) {
      throw createError({ statusCode: 400, statusMessage: 'Bad Request' })
    }
    const base64 = encoded.replace(/-/g, '+').replace(/_/g, '/')
    const padding = base64.length % 4
    const padded = padding ? base64 + '='.repeat(4 - padding) : base64
    let decoded: string
    try {
      decoded = atob(padded)
    }
    catch {
      throw createError({ statusCode: 400, statusMessage: 'Bad Request' })
    }
    const isAllowed = decoded.startsWith('http://') || decoded.startsWith('https://')
    if (!isAllowed) {
      throw createError({ statusCode: 400, statusMessage: 'Bad Request' })
    }
    const target = redirectWithQuery ? withQuery(decoded, getQuery(event)) : decoded
    return sendRedirect(event, target, +redirectStatusCode)
  }

  if (slug && !reserveSlug.includes(slug) && slugRegex.test(slug) && cloudflare) {
    const { KV } = cloudflare.env

    let link: z.infer<typeof LinkSchema> | null = null

    const getLink = async (key: string) =>
      await KV.get(`link:${key}`, { type: 'json', cacheTtl: linkCacheTtl })

    const lowerCaseSlug = slug.toLowerCase()
    link = await getLink(caseSensitive ? slug : lowerCaseSlug)

    // fallback to original slug if caseSensitive is false and the slug is not found
    if (!caseSensitive && !link && lowerCaseSlug !== slug) {
      console.log('original slug fallback:', `slug:${slug} lowerCaseSlug:${lowerCaseSlug}`)
      link = await getLink(slug)
    }

    if (link) {
      event.context.link = link
      try {
        await useAccessLog(event)
      }
      catch (error) {
        console.error('Failed write access log:', error)
      }
      const target = redirectWithQuery ? withQuery(link.url, getQuery(event)) : link.url
      return sendRedirect(event, target, +useRuntimeConfig(event).redirectStatusCode)
    }
  }
})
