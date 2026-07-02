-- Onboarding Course: one fixed 7-lesson course with sequential unlock
CREATE TABLE course_lessons (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lesson_number INTEGER NOT NULL UNIQUE,
  title TEXT NOT NULL,
  description TEXT,
  video_url TEXT,
  duration_minutes INTEGER,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

CREATE TABLE lesson_progress (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  lesson_id UUID REFERENCES course_lessons(id) ON DELETE CASCADE,
  completed_at TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE(user_id, lesson_id)
);

CREATE TABLE lesson_comments (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  lesson_id UUID REFERENCES course_lessons(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,
  content TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Seed the 7 fixed lessons (video_url left null, admin fills in later)
INSERT INTO course_lessons (lesson_number, title, description) VALUES
(1, 'A Quick Overview', 'What the Micro-Training Method is and why it works.'),
(2, 'How The Micro-Training Method Works', 'The full system, step by step.'),
(3, 'Design Your First Micro-Training Offer', 'How to shape an offer people actually want.'),
(4, 'How to Create Your Micro-Training Slides', 'Turning your script into a simple slide deck.'),
(5, 'Your Micro-Training Video Framework', 'The exact structure to follow when you record.'),
(6, 'Launch Your Micro-Training Method Funnel', 'Getting your funnel live and driving traffic.'),
(7, 'Get Your First Client in The Next 30 Days', 'What to do after your training is live.');

CREATE INDEX IF NOT EXISTS idx_lesson_progress_user ON lesson_progress (user_id);
CREATE INDEX IF NOT EXISTS idx_lesson_comments_lesson ON lesson_comments (lesson_id);
