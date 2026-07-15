import {
  Compass, Code, Search, Shield, FlaskConical, Book, Tag, User,
  Network, ClipboardCheck, Gauge, Rocket, MessageCircle, TrendingUp,
} from 'lucide-react';

export const ROLE_ICONS = {
  compass: Compass, code: Code, search: Search, shield: Shield,
  flask: FlaskConical, book: Book, tag: Tag,
  network: Network, 'clipboard-check': ClipboardCheck, gauge: Gauge,
  rocket: Rocket, 'message-circle': MessageCircle, 'trending-up': TrendingUp,
};

export function roleIcon(name) {
  return ROLE_ICONS[name] || User;
}
