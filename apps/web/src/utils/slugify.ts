export function slugifyResourceCode(input: string): string {
  if (!input) return '';
  // Normalize and replace Vietnamese characters
  let text = input.trim();
  text = text.replace(/à|á|ạ|ả|ã|â|ầ|ấ|ậ|ẩ|ẫ|ă|ằ|ắ|ặ|ẳ|ẵ/g, 'a');
  text = text.replace(/À|Á|Ạ|Ả|Ã|Â|Ầ|Ấ|Ậ|Ẩ|Ẫ|Ă|Ằ|Ắ|Ặ|Ẳ|Ẵ/g, 'A');
  text = text.replace(/è|é|ẹ|ẻ|ẽ|ê|ề|ế|ệ|ể|ễ/g, 'e');
  text = text.replace(/È|É|Ẹ|Ẻ|Ẽ|Ê|Ề|Ế|Ệ|Ể|Ễ/g, 'E');
  text = text.replace(/ì|í|ị|ỉ|ĩ/g, 'i');
  text = text.replace(/Ì|Í|Ị|Ỉ|Ĩ/g, 'I');
  text = text.replace(/ò|ó|ọ|ỏ|õ|ô|ồ|ố|ộ|ổ|ỗ|ơ|ờ|ớ|ợ|ở|ỡ/g, 'o');
  text = text.replace(/Ò|Ó|Ọ|Ỏ|Õ|Ô|Ồ|Ố|Ộ|Ổ|Ỗ|Ơ|Ờ|Ớ|Ợ|Ở|Ỡ/g, 'O');
  text = text.replace(/ù|ú|ụ|ủ|ũ|ư|ừ|ứ|ự|ử|ữ/g, 'u');
  text = text.replace(/Ù|Ú|Ụ|Ủ|Ũ|Ư|Ừ|Ứ|Ự|Ử|Ữ/g, 'U');
  text = text.replace(/ỳ|ý|ỵ|ỷ|ỹ/g, 'y');
  text = text.replace(/Ỳ|Ý|Ỵ|Ỷ|Ỹ/g, 'Y');
  text = text.replace(/đ/g, 'd');
  text = text.replace(/Đ/g, 'D');

  // Replace whitespace and prohibited chars with hyphen
  text = text.replace(/[\s/\\#+$]+/g, '-');
  // Keep only alphanumeric and . _ -
  text = text.replace(/[^A-Za-z0-9._-]/g, '');
  // Collapse multiple hyphens
  text = text.replace(/-+/g, '-');
  // Remove leading/trailing hyphens or dots if needed, but must start with letter/digit
  text = text.replace(/^[^A-Za-z0-9]+/, '');
  text = text.replace(/-+$/, '');
  return text.slice(0, 64);
}
