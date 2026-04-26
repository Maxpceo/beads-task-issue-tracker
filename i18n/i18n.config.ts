import { russianPluralRule } from '../app/utils/plural-rules'

export default defineI18nConfig(() => ({
  pluralRules: {
    ru: russianPluralRule,
  },
}))
