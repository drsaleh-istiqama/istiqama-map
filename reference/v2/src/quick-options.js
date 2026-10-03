export const QUICK_OPTIONS=Object.freeze({
  daawaActivities:['حلقات تحفيظ القرآن','دروس شرعية','خطب ومحاضرات','زيارات دعوية','أنشطة شبابية','أنشطة نسائية','دورات تعليمية','مساعدات مجتمعية'],
  socialFeatures:['تعاون مجتمعي قوي','مشاركة شبابية','مشاركة نسائية','رعاية الأيتام','رعاية الأسر المحتاجة','تطوع مجتمعي','مجالس أهلية','ضعف المشاركة المجتمعية'],
  livelihoods:['الزراعة','الصيد','التجارة','الرعي','الوظائف الحكومية','الحرف والمهن','العمل اليومي','السياحة'],
  religiousIssues:['ضعف التعليم الشرعي','نقص الأئمة','نقص المعلمين','ضعف تحفيظ القرآن','ضعف حضور الصلاة','معتقدات أو ممارسات خاطئة','حاجة لبرامج الشباب','حاجة لبرامج النساء'],
  religiousChallenges:['نقص الكادر المؤهل','ضعف التأهيل','قلة المواد التعليمية','بُعد التجمعات السكانية','ضعف الحضور','تعدد اللغات','حساسيات مذهبية','ضعف التمويل'],
  socialChallenges:['الفقر','البطالة','التسرب الدراسي','الزواج المبكر','المخدرات','ضعف النقل','تشتت السكان','مشكلات أسرية'],
  proposedActivities:['حلقات قرآن','تدريب المعلمين','تدريب الأئمة','محاضرات عامة','برامج الشباب','برامج النساء','قافلة دعوية','مساعدات اجتماعية']
});

export function normalizeMultiValue(value){
  const parts=Array.isArray(value)?value:String(value??'').split(/[،,;\n|]+/);
  const seen=new Set(),result=[];
  for(const item of parts){const text=String(item??'').replace(/\s+/g,' ').trim();if(text&&!seen.has(text)){seen.add(text);result.push(text)}}
  return result;
}

export function mergeMultiSelection(selected=[],other=''){
  return normalizeMultiValue([...normalizeMultiValue(selected),...normalizeMultiValue(other)]);
}

export function formatMultiValue(value){return normalizeMultiValue(value).join('، ')}
