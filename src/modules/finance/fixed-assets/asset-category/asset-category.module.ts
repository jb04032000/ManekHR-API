import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { AssetCategory, AssetCategorySchema } from './asset-category.schema';
import { AssetCategoryService } from './asset-category.service';
import { AssetCategoryController } from './asset-category.controller';

@Module({
  imports: [MongooseModule.forFeature([{ name: AssetCategory.name, schema: AssetCategorySchema }])],
  controllers: [AssetCategoryController],
  providers: [AssetCategoryService],
  exports: [AssetCategoryService, MongooseModule],
})
export class AssetCategoryModule {}
