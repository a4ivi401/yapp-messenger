import { z } from 'zod';

/**
 * Локалізація повідомлень про помилки Zod українською мовою.
 * Забезпечує людинозрозумілі повідомлення про помилки валідації для API та сокетів.
 */
export const ukrainianErrorMap = (issue, ctx) => {
  if (issue.code === z.ZodIssueCode.invalid_type) {
    if (issue.received === 'undefined') {
      return { message: 'Поле є обовʼязковим' };
    }
    if (issue.received === 'null') {
      return { message: 'Поле не може бути порожнім' };
    }
    return { message: 'Некоректний тип даних' };
  }

  if (issue.code === z.ZodIssueCode.too_small) {
    if (issue.type === 'string') {
      if (issue.exact) {
        return { message: `Довжина має бути рівно ${issue.minimum} симв.` };
      }
      return {
        message: issue.inclusive
          ? `Мінімум ${issue.minimum} симв.`
          : `Має бути більше ніж ${issue.minimum} симв.`,
      };
    }
    if (issue.type === 'number') {
      return {
        message: issue.inclusive
          ? `Значення має бути не менше ${issue.minimum}`
          : `Значення має бути більше за ${issue.minimum}`,
      };
    }
    if (issue.type === 'array') {
      return {
        message: `Має містити щонайменше ${issue.minimum} елементів`,
      };
    }
    return { message: `Значення замале (мін. ${issue.minimum})` };
  }

  if (issue.code === z.ZodIssueCode.too_big) {
    if (issue.type === 'string') {
      if (issue.exact) {
        return { message: `Довжина має бути рівно ${issue.maximum} симв.` };
      }
      return {
        message: issue.inclusive
          ? `Максимум ${issue.maximum} симв.`
          : `Має бути менше ніж ${issue.maximum} симв.`,
      };
    }
    if (issue.type === 'number') {
      return {
        message: issue.inclusive
          ? `Значення має бути не більше ${issue.maximum}`
          : `Значення має бути менше за ${issue.maximum}`,
      };
    }
    if (issue.type === 'array') {
      return {
        message: `Має містити не більше ${issue.maximum} елементів`,
      };
    }
    return { message: `Значення завелике (макс. ${issue.maximum})` };
  }

  if (issue.code === z.ZodIssueCode.invalid_string) {
    if (issue.validation === 'uuid') {
      return { message: 'Некоректний формат ідентифікатора (UUID)' };
    }
    if (issue.validation === 'email') {
      return { message: 'Некоректна адреса електронної пошти' };
    }
    if (issue.validation === 'url') {
      return { message: 'Некоректне посилання (URL)' };
    }
    if (issue.validation === 'regex') {
      return { message: 'Некоректний формат поля' };
    }
    return { message: 'Некоректний формат рядка' };
  }

  if (issue.code === z.ZodIssueCode.invalid_enum_value) {
    return { message: 'Обрано неприпустиме значення зі списку' };
  }

  if (issue.code === z.ZodIssueCode.custom) {
    return { message: issue.message || 'Некоректні дані' };
  }

  return { message: ctx.defaultError || 'Некоректні дані' };
};

export function setupZodLocalization() {
  z.setErrorMap(ukrainianErrorMap);
}
